/**
 * Classify "a backing service is down" errors so they don't all land in the
 * same opaque 500.
 *
 * Every dependency failure used to return a byte-identical
 * `INTERNAL_ERROR / "share the request id with support"`. On a self-hosted
 * deployment the operator IS support: Postgres-down and Redis-down needed
 * different actions, and the response gave no way to tell them apart. This maps
 * connection-level failures to a 503 that names the subsystem.
 *
 * Deliberately conservative. An outbound call to a billing provider produces the
 * same `ECONNREFUSED`/`ENOTFOUND` codes as a dead Redis, and mislabelling
 * "Stripe is unreachable" as "your Redis is down" would send an operator to
 * restart the wrong thing. So a bare connection code is only accepted when the
 * error also carries a marker that it came off a local socket we own
 * (ioredis attaches `command`; a raw `net` connect error carries `syscall`), and
 * provider-SDK errors are excluded outright.
 */

export type OutageSubsystem = 'postgres' | 'redis';

/** Human label used in the response `message`. No host, port, or DSN. */
export const OUTAGE_SUBSYSTEM_LABEL: Record<OutageSubsystem, string> = {
  postgres: 'PostgreSQL database',
  redis: 'Redis cache/queue',
};

/**
 * Prisma connection-level error codes.
 *   P1001 — can't reach the database server
 *   P1017 — server closed the connection
 * `PrismaClientInitializationError` carries the code on `errorCode` instead of
 * `code`, and can also surface with no code at all (bad DSN, no server).
 */
const PRISMA_CONNECTION_CODES = new Set(['P1001', 'P1017']);

/**
 * ioredis command rejections during an outage. With `enableOfflineQueue: false`
 * (see lib/redis.ts) a command against a dead connection rejects with one of
 * these messages rather than a socket error code.
 */
const REDIS_MESSAGE_PATTERNS =
  /Stream isn't writeable|Connection is closed|Reached the max retries per request/i;

/** Socket-level codes that mean "nothing answered". */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/** Errors from a payment/OAuth provider SDK are never a local dependency. */
const PROVIDER_ERROR_NAME = /^(Stripe|Razorpay|PayPal)/i;

/**
 * Does this look like a raw exception from a payment-provider SDK?
 *
 * Lives here (rather than next to the provider-error mapper in
 * `provider-errors.ts`) because `lib/error.ts` needs it as a last-resort
 * guard and already imports this module — importing the mapper instead would
 * be a cycle, since the mapper imports `RekeyError` from `error.ts`.
 */
export function isProviderSdkError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' && PROVIDER_ERROR_NAME.test(name);
}

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  errorCode?: unknown;
  message?: unknown;
  syscall?: unknown;
  command?: unknown;
  cause?: unknown;
}

function asErrorLike(err: unknown): ErrorLike | null {
  return typeof err === 'object' && err !== null ? (err as ErrorLike) : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Which backing service is unreachable, or `null` when this isn't a dependency
 * outage (in which case the caller keeps its existing 500 handling).
 */
export function classifyDependencyOutage(err: unknown): OutageSubsystem | null {
  const e = asErrorLike(err);
  if (!e) return null;

  const name = str(e.name);
  const code = str(e.code);
  const message = str(e.message);

  // Postgres, via Prisma.
  if (PRISMA_CONNECTION_CODES.has(code) || PRISMA_CONNECTION_CODES.has(str(e.errorCode))) {
    return 'postgres';
  }
  if (name === 'PrismaClientInitializationError') return 'postgres';

  // A provider SDK wrapping a socket failure is not our dependency.
  if (PROVIDER_ERROR_NAME.test(name)) return null;
  // `fetch` wraps the real socket error in `cause` — outbound HTTP, not us.
  if (e.cause !== undefined) return null;

  // Redis, via ioredis.
  if (REDIS_MESSAGE_PATTERNS.test(message)) return 'redis';
  if (CONNECTION_ERROR_CODES.has(code) && (e.command !== undefined || str(e.syscall) !== '')) {
    return 'redis';
  }

  return null;
}

/**
 * Throttled audit trail for dependency outages.
 *
 * A Redis or Postgres outage hits every request, so writing one security-event
 * row per failure would flood the very log an operator opens to understand what
 * happened. One row per (subsystem, tenant) per window is enough to answer "when
 * did this start" without burying anything else.
 *
 * Deliberately keyed with tenantId in it: `listSecurityEvents` filters on
 * tenantId, so a row written without one can never reach the panel — a trap this
 * codebase has fallen into before.
 *
 * Best-effort by construction: `recordSecurityEvent` swallows its own errors, and
 * during a Postgres outage this write will itself fail. That is fine. The log line
 * in the error handler is the primary signal; this is the durable one for when
 * Postgres is up and Redis is not, which is the common case.
 */
const OUTAGE_EVENT_WINDOW_MS = 5 * 60 * 1000;
const lastOutageEventAt = new Map<string, number>();

export function shouldRecordOutageEvent(subsystem: OutageSubsystem, tenantId: string | null): boolean {
  const key = `${subsystem}:${tenantId ?? '-'}`;
  const now = Date.now();
  const previous = lastOutageEventAt.get(key) ?? 0;
  if (now - previous < OUTAGE_EVENT_WINDOW_MS) return false;
  lastOutageEventAt.set(key, now);
  return true;
}

/**
 * Forget every recorded window.
 *
 * Test-only. The 5-minute suppression window outlives a whole test file, so
 * the FIRST test to provoke an outage event silences every later one for the
 * same (subsystem, tenant) — including tests whose entire assertion is that
 * the row was written. Called from test/setup.ts's beforeEach.
 */
export function __resetForTests(): void {
  lastOutageEventAt.clear();
}
