/**
 * The shared Prisma client.
 *
 * ## Connection pool sizing
 *
 * Prisma sizes its pool from the connection string, not from client options,
 * and the URL carried no sizing at all — so every deployment ran on Prisma's
 * default of `num_cpus * 2 + 1`. On a 2-vCPU container that is **five
 * connections**, shared by:
 *
 *   - every HTTP handler,
 *   - the BullMQ webhook worker at `WORKER_CONCURRENCY = 10`
 *     (modules/webhooks/webhook.queue.ts) — which alone can want more
 *     connections than the pool has,
 *   - the periodic jobs registered in app.ts (request-log flush + prune,
 *     token prune, delivery poller, dunning scheduler).
 *
 * A webhook burst therefore starved the HTTP handlers: requests waited out
 * `pool_timeout` and failed, while `/health/live` — which touches no
 * connection — stayed green.
 *
 * `DATABASE_POOL_SIZE` and `DATABASE_POOL_TIMEOUT_SECONDS` set
 * `connection_limit` / `pool_timeout` on the URL. The default of 20 is chosen
 * to exceed the worker concurrency with room left for the request path, rather
 * than to track CPU count: the pressure here is concurrent I/O waits, not
 * compute. Raise it toward your Postgres `max_connections` divided by the
 * number of API replicas — not past it, or the API just moves the queue from
 * Prisma into Postgres.
 *
 * A value already present in the URL always wins, so an operator who has tuned
 * the connection string directly is never overridden.
 */

import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __rekeyPrisma: PrismaClient | undefined;
}

/** Pool size when neither the URL nor the environment says otherwise. */
const DEFAULT_POOL_SIZE = 20;
/** Seconds a checkout waits before Prisma gives up (Prisma's own default). */
const DEFAULT_POOL_TIMEOUT_SECONDS = 10;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Return `url` with `connection_limit` / `pool_timeout` applied, leaving any
 * value the operator already set untouched. Returns the input unchanged when
 * it doesn't parse — an unparseable DATABASE_URL is the env validator's to
 * report (config/env.ts), not this function's to throw on at import time.
 *
 * Exported for the unit test; nothing else should call it.
 */
export function withPoolSettings(url: string, env: NodeJS.ProcessEnv = process.env): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.searchParams.has('connection_limit')) {
    parsed.searchParams.set(
      'connection_limit',
      String(positiveInt(env.DATABASE_POOL_SIZE, DEFAULT_POOL_SIZE)),
    );
  }
  if (!parsed.searchParams.has('pool_timeout')) {
    parsed.searchParams.set(
      'pool_timeout',
      String(positiveInt(env.DATABASE_POOL_TIMEOUT_SECONDS, DEFAULT_POOL_TIMEOUT_SECONDS)),
    );
  }
  return parsed.toString();
}

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  // No URL here means the env validator will fail the boot with a far better
  // message than a URL parse error would. Build the client the plain way and
  // let that happen.
  if (!url) return new PrismaClient();
  return new PrismaClient({ datasources: { db: { url: withPoolSettings(url) } } });
}

// Reuse the client across `tsx watch` reloads so we don't exhaust DB
// connections during development.
export const prisma = globalThis.__rekeyPrisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__rekeyPrisma = prisma;
}
