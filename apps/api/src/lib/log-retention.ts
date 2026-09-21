/**
 * Retention for the append-only log tables.
 *
 * Three tables only ever grew: `security_events`, `email_logs` and
 * `webhook_deliveries`. Nothing deleted a row from any of them, so each was a
 * disk that only fills, and, more immediately, a table in the hot path of the
 * operator console's heaviest reads, in every backup and every restore.
 *
 * This sweeps rows older than `LOG_RETENTION_DAYS` on the existing 10-minute
 * prune timer, in bounded batches so a first run against a large backlog
 * cannot hold locks for long. With an archiver configured, each batch is
 * written out BEFORE it is deleted, and a failed upload leaves the batch in
 * place for the next sweep. Deletion never races ahead of the archive.
 *
 * ## What is deliberately not here
 *
 * `usage_records` looks like a log and is not one. It is a billing ledger: its
 * `(meter, subject, idempotencyKey)` unique constraint is what makes a replayed
 * usage event a no-op, and period totals are summed from it. Pruning it would
 * reopen double-charging for any client that retries past the window. Data
 * erasure retains it for accounting for the same reason.
 *
 * ## Why deliveries age by `updatedAt`
 *
 * A PENDING delivery is live retry state and is never touched. SUCCEEDED and
 * FAILED are terminal, but an operator can redeliver a FAILED one, which flips
 * it back to PENDING. Ageing by `updatedAt` means "nobody has touched this in
 * the window", so a delivery redelivered yesterday is not swept because it was
 * first created last month. The delete re-applies the same predicate, so a
 * redeliver that lands between the read and the delete wins.
 *
 * ## Archive semantics
 *
 * At-least-once. Object keys are derived from the ids in the batch, so a sweep
 * that uploads and then fails to delete re-uploads the same object next time
 * rather than a duplicate. A row that changes between upload and delete (the
 * redeliver case) stays live and is archived again when it next ages out.
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { prisma } from './prisma.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A cap per sweep, so one tick against a huge backlog is still bounded. */
const DEFAULT_MAX_BATCHES_PER_TABLE = 20;

export type RetainedTableName = 'security_events' | 'email_logs' | 'webhook_deliveries';

/**
 * Where pruned rows go before they are deleted.
 *
 * `put` MUST reject on any failure. A rejected put is the only thing that stops
 * the delete; an archiver that swallows an error deletes rows it never stored.
 */
export interface LogArchiver {
  put(key: string, body: Uint8Array): Promise<void>;
}

type Row = { id: string } & Record<string, unknown>;

interface RetainedTable {
  name: RetainedTableName;
  /**
   * Rows per batch. Deliveries carry a full payload and response body, so they
   * batch smaller: the batch is held in memory while it is archived.
   */
  batch: number;
  /** The column a row ages by, and the one its archive date partition uses. */
  ageColumn: 'createdAt' | 'updatedAt';
  /** Oldest-first. `full` selects every column (for the archive); otherwise ids only. */
  findStale(cutoff: Date, take: number, full: boolean): Promise<Row[]>;
  /** Re-applies the staleness predicate, so a row that changed since the read survives. */
  deleteStale(ids: string[], cutoff: Date): Promise<number>;
}

const TERMINAL_DELIVERY_STATUSES = ['SUCCEEDED', 'FAILED'] as const;

const TABLES: readonly RetainedTable[] = [
  {
    name: 'security_events',
    batch: 2_000,
    ageColumn: 'createdAt',
    async findStale(cutoff, take, full) {
      const where = { createdAt: { lt: cutoff } };
      const orderBy = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
      return full
        ? prisma.securityEvent.findMany({ where, orderBy, take })
        : prisma.securityEvent.findMany({ where, orderBy, take, select: { id: true } });
    },
    async deleteStale(ids, cutoff) {
      const { count } = await prisma.securityEvent.deleteMany({
        where: { id: { in: ids }, createdAt: { lt: cutoff } },
      });
      return count;
    },
  },
  {
    name: 'email_logs',
    batch: 2_000,
    ageColumn: 'createdAt',
    async findStale(cutoff, take, full) {
      const where = { createdAt: { lt: cutoff } };
      const orderBy = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
      return full
        ? prisma.emailLog.findMany({ where, orderBy, take })
        : prisma.emailLog.findMany({ where, orderBy, take, select: { id: true } });
    },
    async deleteStale(ids, cutoff) {
      const { count } = await prisma.emailLog.deleteMany({
        where: { id: { in: ids }, createdAt: { lt: cutoff } },
      });
      return count;
    },
  },
  {
    name: 'webhook_deliveries',
    batch: 200,
    ageColumn: 'updatedAt',
    async findStale(cutoff, take, full) {
      const where = {
        status: { in: [...TERMINAL_DELIVERY_STATUSES] },
        updatedAt: { lt: cutoff },
      };
      const orderBy = [{ updatedAt: 'asc' as const }, { id: 'asc' as const }];
      return full
        ? prisma.webhookDelivery.findMany({ where, orderBy, take })
        : prisma.webhookDelivery.findMany({ where, orderBy, take, select: { id: true } });
    },
    async deleteStale(ids, cutoff) {
      const { count } = await prisma.webhookDelivery.deleteMany({
        where: {
          id: { in: ids },
          status: { in: [...TERMINAL_DELIVERY_STATUSES] },
          updatedAt: { lt: cutoff },
        },
      });
      return count;
    },
  },
];

/**
 * The object key for one table-day of a batch.
 *
 * `dt=YYYY-MM-DD` is Hive-style partitioning, so Athena, DuckDB and ClickHouse
 * can prune by date without a manifest. The file name is a digest of the ids
 * rather than a timestamp, which is what makes a retried upload overwrite its
 * own object instead of writing a duplicate.
 */
export function archiveKey(table: RetainedTableName, day: string, ids: readonly string[]): string {
  const digest = createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 16);
  return `${table}/dt=${day}/${digest}.ndjson.gz`;
}

function utcDay(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString().slice(0, 10);
}

/** Group a batch by UTC day of its age column and upload one object per day. */
async function archiveBatch(
  table: RetainedTable,
  rows: readonly Row[],
  archiver: LogArchiver,
): Promise<number> {
  const byDay = new Map<string, Row[]>();
  for (const row of rows) {
    const day = utcDay(row[table.ageColumn]);
    const group = byDay.get(day);
    if (group) group.push(row);
    else byDay.set(day, [row]);
  }
  for (const [day, group] of byDay) {
    const ndjson = group.map((row) => JSON.stringify(row)).join('\n') + '\n';
    await archiver.put(
      archiveKey(
        table.name,
        day,
        group.map((row) => row.id),
      ),
      gzipSync(ndjson),
    );
  }
  return byDay.size;
}

export interface PruneLogsOptions {
  retentionDays: number;
  /** Null or absent: prune without archiving. */
  archiver?: LogArchiver | null;
  now?: Date;
  maxBatchesPerTable?: number;
}

export interface PruneLogsResult {
  deleted: Record<RetainedTableName, number>;
  archivedObjects: number;
  /** A failed table stops at its failed batch; the other tables still run. */
  failures: Array<{ table: RetainedTableName; error: unknown }>;
}

export async function pruneLogs(options: PruneLogsOptions): Promise<PruneLogsResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.retentionDays * DAY_MS);
  const archiver = options.archiver ?? null;
  const maxBatches = options.maxBatchesPerTable ?? DEFAULT_MAX_BATCHES_PER_TABLE;

  const result: PruneLogsResult = {
    deleted: { security_events: 0, email_logs: 0, webhook_deliveries: 0 },
    archivedObjects: 0,
    failures: [],
  };
  // Zero days would put the cutoff at now and delete every row. Unset retention
  // means keep forever, so a caller that forgets to map it to null keeps rows.
  if (!(options.retentionDays > 0)) return result;

  for (const table of TABLES) {
    try {
      for (let i = 0; i < maxBatches; i++) {
        const rows = await table.findStale(cutoff, table.batch, archiver !== null);
        if (rows.length === 0) break;
        // Archive first. If this throws, the delete below never runs.
        if (archiver) result.archivedObjects += await archiveBatch(table, rows, archiver);
        result.deleted[table.name] += await table.deleteStale(
          rows.map((row) => row.id),
          cutoff,
        );
        if (rows.length < table.batch) break;
      }
    } catch (error) {
      result.failures.push({ table: table.name, error });
    }
  }

  return result;
}
