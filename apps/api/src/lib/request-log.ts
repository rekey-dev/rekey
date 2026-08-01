/**
 * Per-request access log writer + reader + pruner.
 *
 * Records one row per HTTP response. This is a **bounded convenience tail** the
 * panel renders — the authoritative request log is structured stdout
 * (`req.log`). Three hard rules, all load-bearing for not re-introducing the
 * crash this feature guards against:
 *
 *   1. **No DB write on the request path.** `recordApiRequest` only pushes the
 *      row into an in-memory buffer — it touches no connection and never
 *      throws. A periodic flush (`flushApiRequestLogs`) writes the whole buffer
 *      in ONE `createMany`. Per-request inserts would put one un-awaited query
 *      on the connection pool per request; under load that starves the pool
 *      (and contends with everything else) — the exact failure we're avoiding.
 *      Batching decouples DB write volume from request volume.
 *
 *   2. **Best-effort, never fatal.** Both the enqueue and the flush swallow
 *      their errors. A dropped batch is a shorter tail, not a broken request.
 *
 *   3. **Never prune per-insert.** A separate periodic job
 *      (`pruneApiRequestLogs`) caps each app/operator to the last N rows. See
 *      app.ts for where the flush + prune intervals are started.
 */

import { prisma } from './prisma.js';

/** Default rows kept per application / per operator by the pruner. */
export const DEFAULT_KEEP_PER_GROUP = 200;

/** routePath is a route *pattern* (`/api/v1/auth/sign-in`), but cap defensively. */
const MAX_ROUTE_PATH = 512;

/** Flush early once this many rows are buffered, so a burst can't grow it unbounded. */
const MAX_BUFFER = 1000;

export interface ApiRequestLogInput {
  method: string;
  /** The matched route pattern, not the concrete URL (no ids/query). */
  routePath: string;
  statusCode: number;
  durationMs: number;
  applicationId?: string | null;
  tenantId?: string | null;
  operatorUserId?: string | null;
  ip?: string | null;
}

interface BufferedRow {
  method: string;
  routePath: string;
  statusCode: number;
  durationMs: number;
  applicationId: string | null;
  tenantId: string | null;
  operatorUserId: string | null;
  ip: string | null;
  createdAt: Date;
}

let buffer: BufferedRow[] = [];
let flushing = false;

/**
 * Enqueue one request-log row. Synchronous, allocation-only — no DB, no
 * connection, never throws. The `createdAt` is stamped now (at response time)
 * so ordering is accurate even though the row is written later in a batch.
 */
export function recordApiRequest(input: ApiRequestLogInput): void {
  buffer.push({
    method: input.method.slice(0, 16),
    routePath: input.routePath.slice(0, MAX_ROUTE_PATH),
    statusCode: input.statusCode,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    applicationId: input.applicationId ?? null,
    tenantId: input.tenantId ?? null,
    operatorUserId: input.operatorUserId ?? null,
    ip: input.ip ?? null,
    createdAt: new Date(),
  });
  // Hard cap: if a burst outruns the flush timer, drop the oldest rows rather
  // than let the buffer grow without bound (the tail is lossy by design).
  if (buffer.length > MAX_BUFFER) {
    buffer.splice(0, buffer.length - MAX_BUFFER);
  }
}

/**
 * Write the buffered rows in a single `createMany` and clear the buffer.
 * Best-effort: returns the number of rows written, swallows errors (a failed
 * flush drops that batch — stdout remains the source of truth). Re-entrancy
 * guarded so two timers / a timer + a shutdown flush can't double-write.
 */
/**
 * Discard whatever is buffered without writing it.
 *
 * Test-only. This buffer is module-level and flushed by a TIMER, which makes
 * it the documented cause of the TRUNCATE deadlock retry in test/setup.ts:
 * rows enqueued by one test are still in flight — or land mid-TRUNCATE — while
 * the next takes an AccessExclusiveLock on `api_request_logs`. Dropping the
 * buffer between tests removes the write that the retry loop exists to
 * survive. Called from test/setup.ts's beforeEach.
 *
 * `flushing` is deliberately NOT reset: an in-flight `createMany` still owns
 * the flag and will clear it in its own `finally`.
 */
export function __resetForTests(): void {
  buffer = [];
}

export async function flushApiRequestLogs(): Promise<number> {
  if (flushing || buffer.length === 0) return 0;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    await prisma.apiRequestLog.createMany({ data: batch });
    return batch.length;
  } catch {
    // Best-effort: drop the batch rather than retry-loop on the request log.
    return 0;
  } finally {
    flushing = false;
  }
}

export interface ApiRequestLogRow {
  id: string;
  method: string;
  routePath: string;
  statusCode: number;
  durationMs: number;
  applicationId: string | null;
  tenantId: string | null;
  operatorUserId: string | null;
  ip: string | null;
  createdAt: Date;
}

export interface ApiRequestLogQuery {
  /** Filter to one application's inbound API-key traffic. */
  applicationId?: string | undefined;
  /** Filter to one operator's own (panel/tenant-API) requests. */
  operatorUserId?: string | undefined;
  take: number;
  skip: number;
}

/** List request-log rows newest-first for a single app or operator. */
export async function listApiRequests(
  query: ApiRequestLogQuery,
): Promise<ApiRequestLogRow[]> {
  const rows = await prisma.apiRequestLog.findMany({
    where: {
      ...(query.applicationId !== undefined && { applicationId: query.applicationId }),
      ...(query.operatorUserId !== undefined && { operatorUserId: query.operatorUserId }),
    },
    orderBy: { createdAt: 'desc' },
    take: query.take,
    skip: query.skip,
  });
  return rows.map((r) => ({
    id: r.id,
    method: r.method,
    routePath: r.routePath,
    statusCode: r.statusCode,
    durationMs: r.durationMs,
    applicationId: r.applicationId,
    tenantId: r.tenantId,
    operatorUserId: r.operatorUserId,
    ip: r.ip,
    createdAt: r.createdAt,
  }));
}

/**
 * Cap the table to the last `keepPerGroup` rows per application, per operator,
 * and (as a backstop) per the anonymous bucket — using a window function so
 * the whole sweep is three set-based DELETEs, not a per-row loop. Idempotent
 * and best-effort: returns the number of rows deleted, swallows errors (the
 * rows are harmless if a sweep is skipped — the next tick catches up).
 *
 * Why three statements: API-key traffic carries `application_id` (operator
 * null) and operator/panel traffic carries `operator_user_id` (application
 * null), so the two populations are disjoint; the third handles fully
 * unauthenticated requests (health checks, 404s, webhooks) which carry
 * neither and would otherwise grow unbounded.
 */
export async function pruneApiRequestLogs(
  keepPerGroup: number = DEFAULT_KEEP_PER_GROUP,
): Promise<number> {
  const keep = Math.max(1, Math.floor(keepPerGroup));
  try {
    const perApp = await prisma.$executeRawUnsafe(
      `DELETE FROM "api_request_logs"
       WHERE "id" IN (
         SELECT "id" FROM (
           SELECT "id", row_number() OVER (
             PARTITION BY "application_id" ORDER BY "created_at" DESC, "id" DESC
           ) AS rn
           FROM "api_request_logs"
           WHERE "application_id" IS NOT NULL
         ) ranked WHERE ranked.rn > $1
       )`,
      keep,
    );
    const perOperator = await prisma.$executeRawUnsafe(
      `DELETE FROM "api_request_logs"
       WHERE "id" IN (
         SELECT "id" FROM (
           SELECT "id", row_number() OVER (
             PARTITION BY "operator_user_id" ORDER BY "created_at" DESC, "id" DESC
           ) AS rn
           FROM "api_request_logs"
           WHERE "operator_user_id" IS NOT NULL
         ) ranked WHERE ranked.rn > $1
       )`,
      keep,
    );
    const anonymous = await prisma.$executeRawUnsafe(
      `DELETE FROM "api_request_logs"
       WHERE "application_id" IS NULL AND "operator_user_id" IS NULL
       AND "id" IN (
         SELECT "id" FROM (
           SELECT "id", row_number() OVER (
             ORDER BY "created_at" DESC, "id" DESC
           ) AS rn
           FROM "api_request_logs"
           WHERE "application_id" IS NULL AND "operator_user_id" IS NULL
         ) ranked WHERE ranked.rn > $1
       )`,
      keep,
    );
    return Number(perApp) + Number(perOperator) + Number(anonymous);
  } catch {
    // Best-effort: an over-cap table is a tail-length problem, not a
    // correctness one. The next tick retries.
    return 0;
  }
}
