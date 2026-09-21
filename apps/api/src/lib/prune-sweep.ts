/**
 * The ten-minute prune sweep, run on one replica at a time.
 *
 * app.ts starts the timer in every replica. Each tick calls `runPruneSweep`,
 * which takes the `lease:prune-sweep` lease (lib/sweep-lease.ts) and skips the
 * tick when another replica holds it or Redis cannot be reached. Inside the
 * lease the pruners run one after another rather than all at once, so a
 * single sweep does not open six concurrent delete statements against the
 * same database either.
 *
 * Every pruner is isolated: one failing logs a warning and the rest still run.
 */

import type { Redis } from 'ioredis';
import { pruneApiRequestLogs } from './request-log.js';
import {
  pruneExpiredAuthTokens,
  pruneExpiredIdempotencyKeys,
  pruneExpiredSessionTokens,
} from './token-prune.js';
import { pruneExpiredChallenges } from './webauthn-challenge.js';
import { pruneWebhookEvents } from '../modules/billing/webhooks/retention.js';
import { pruneLogs, type LogArchiver } from './log-retention.js';
import { withLease, type LeaseOutcome, type LeaseRedis } from './sweep-lease.js';

export const PRUNE_SWEEP_LEASE_KEY = 'lease:prune-sweep';
/**
 * Short, and renewed every 20 s while the sweep runs. A replica that dies
 * mid-sweep holds the lease for at most a minute, well inside the ten-minute
 * interval, so the next tick is never lost to a crash.
 */
export const PRUNE_SWEEP_LEASE_TTL_MS = 60_000;

export interface SweepLogger {
  debug(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface PruneSweepOptions {
  logRetentionDays: number | null;
  webhookEventRetentionDays: number | null;
  logArchiver: LogArchiver | null;
  log: SweepLogger;
  /** Overridable for tests. */
  leaseKey?: string;
  leaseTtlMs?: number;
}

async function step(log: SweepLogger, label: string, run: () => Promise<number>): Promise<void> {
  try {
    const deleted = await run();
    if (deleted > 0) log.debug({ deleted }, `pruned ${label}`);
  } catch (err) {
    log.warn({ err }, `${label} prune failed`);
  }
}

async function sweepOnce(options: PruneSweepOptions): Promise<void> {
  const { log } = options;
  await step(log, 'api_request_logs', () => pruneApiRequestLogs());
  // Magic links, OAuth auth codes (app and operator MCP): inert past expiry.
  await step(log, 'expired auth tokens', () => pruneExpiredAuthTokens());
  // Refresh, reset and verification tokens, batched (token-prune.ts).
  await step(log, 'expired session tokens', () => pruneExpiredSessionTokens());
  await step(log, 'expired webauthn challenges', () => pruneExpiredChallenges());
  // Generic Idempotency-Key rows (24 h TTL); also clears crash-orphaned reservations.
  await step(log, 'expired idempotency keys', () => pruneExpiredIdempotencyKeys());
  // Inbound billing-webhook receipts; a provider retries for days, not months.
  const webhookDays = options.webhookEventRetentionDays;
  if (webhookDays !== null) {
    await step(log, 'inbound webhook receipts', () => pruneWebhookEvents(webhookDays));
  }
  if (options.logRetentionDays !== null) {
    try {
      const result = await pruneLogs({
        retentionDays: options.logRetentionDays,
        archiver: options.logArchiver,
      });
      const deleted = Object.values(result.deleted).reduce((a, b) => a + b, 0);
      if (deleted > 0 || result.archivedObjects > 0) {
        log.debug(
          { deleted: result.deleted, archivedObjects: result.archivedObjects },
          'pruned log tables',
        );
      }
      for (const failure of result.failures) {
        log.warn(
          { table: failure.table, err: failure.error },
          'log-table prune failed; rows left in place for the next sweep',
        );
      }
    } catch (err) {
      log.warn({ err }, 'log-table prune failed');
    }
  }
}

export async function runPruneSweep(
  redis: LeaseRedis | Redis | null,
  options: PruneSweepOptions,
): Promise<LeaseOutcome<void>> {
  const outcome = await withLease(
    redis,
    {
      key: options.leaseKey ?? PRUNE_SWEEP_LEASE_KEY,
      ttlMs: options.leaseTtlMs ?? PRUNE_SWEEP_LEASE_TTL_MS,
      onError: (err, phase) => options.log.warn({ err, phase }, 'prune sweep lease command failed'),
    },
    () => sweepOnce(options),
  );
  if (outcome.status === 'held') {
    options.log.debug({}, 'prune sweep skipped: another replica holds the lease');
  } else if (outcome.status === 'redis-unavailable') {
    options.log.warn(
      { err: outcome.error },
      'prune sweep skipped: Redis unavailable, not running unleased',
    );
  }
  return outcome;
}
