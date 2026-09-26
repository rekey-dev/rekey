/**
 * The shared Prisma client.
 *
 * ## Connection pool sizing
 *
 * Prisma sizes its pool from the connection string, not from client options,
 * and the URL carried no sizing at all, so every deployment ran on Prisma's
 * default of `num_cpus * 2 + 1`. On a 2-vCPU container that is **five
 * connections**, shared by:
 *
 *   - every HTTP handler,
 *   - the BullMQ webhook worker (modules/webhooks/webhook.queue.ts), which
 *     alone could want more connections than the pool has. It then ran 10
 *     attempts at once; it now runs 50, whose database statements share at
 *     most half the pool (the delivery lanes in webhook.service.ts),
 *   - the periodic jobs registered in app.ts (request-log flush + prune,
 *     token prune, delivery poller, dunning scheduler).
 *
 * A webhook burst therefore starved the HTTP handlers: requests waited out
 * `pool_timeout` and failed, while `/health/live`, which touches no
 * connection, stayed green.
 *
 * `DATABASE_POOL_SIZE` and `DATABASE_POOL_TIMEOUT_SECONDS` set
 * `connection_limit` / `pool_timeout` on the URL. The default of 20 is chosen
 * to exceed the worker concurrency with room left for the request path, rather
 * than to track CPU count: the pressure here is concurrent I/O waits, not
 * compute. Raise it toward your Postgres `max_connections` divided by the
 * number of API replicas, not past it, or the API just moves the queue from
 * Prisma into Postgres.
 *
 * A value already present in the URL always wins, so an operator who has tuned
 * the connection string directly is never overridden.
 *
 * ## Interactive transactions wait as long as plain queries
 *
 * `pool_timeout` only governs plain queries. An interactive `$transaction`
 * acquires its connection under its own `maxWait`, which Prisma defaults to
 * 2 seconds. Left alone, a burst that a plain write would have queued through
 * failed every transactional write with P2028 at the two second mark, and
 * sign-up, email verification, session revoke, password change and the other
 * writes that now carry their webhook rows in the same transaction were the
 * first to go. `maxWait` is therefore derived from the SAME effective
 * `pool_timeout` the URL ends up with, so both paths give up together.
 * `timeout` stays at Prisma's 5 second default, spelled out so it is visible;
 * a call that passes its own options still wins over both.
 */

import { PrismaClient, type Prisma } from '@prisma/client';

declare global {
  var __rekeyPrisma: PrismaClient | undefined;
}

/** Pool size when neither the URL nor the environment says otherwise. */
const DEFAULT_POOL_SIZE = 20;
/** Seconds a checkout waits before Prisma gives up (Prisma's own default). */
const DEFAULT_POOL_TIMEOUT_SECONDS = 10;
/** Longest an interactive transaction may run once it has a connection. */
const DEFAULT_TRANSACTION_TIMEOUT_MS = 5_000;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Return `url` with `connection_limit` / `pool_timeout` applied, leaving any
 * value the operator already set untouched. Returns the input unchanged when
 * it doesn't parse, an unparseable DATABASE_URL is the env validator's to
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

/**
 * `maxWait` / `timeout` for every interactive transaction, see the module
 * docblock. `maxWait` is the effective `pool_timeout` of `url` (the URL's own
 * value, else the environment's, else the default). A `pool_timeout` of 0
 * means "wait forever" to Prisma's pool; a transaction still needs a bound,
 * so that case falls back to the default rather than passing 0 through.
 *
 * Exported for the unit test; nothing else should call it.
 */
export function transactionOptionsFor(
  url: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { maxWait: number; timeout: number } {
  let seconds = positiveInt(env.DATABASE_POOL_TIMEOUT_SECONDS, DEFAULT_POOL_TIMEOUT_SECONDS);
  if (url) {
    try {
      const fromUrl = new URL(url).searchParams.get('pool_timeout');
      if (fromUrl !== null) seconds = positiveInt(fromUrl, DEFAULT_POOL_TIMEOUT_SECONDS);
    } catch {
      // Unparseable URL: the env validator reports it, see withPoolSettings.
    }
  }
  return { maxWait: seconds * 1000, timeout: DEFAULT_TRANSACTION_TIMEOUT_MS };
}

/**
 * Under NODE_ENV=test the client emits a `query` event per SQL statement, so a
 * test can count the round trips a request costs (`test/query-counter.ts`).
 * Nothing subscribes outside the suite, and production never builds the
 * emitter at all.
 */
const testLog: Prisma.PrismaClientOptions =
  process.env.NODE_ENV === 'test' ? { log: [{ emit: 'event', level: 'query' }] } : {};

/**
 * Everything the shared client is built with, from a DATABASE_URL. Split out
 * of `createClient` so a test can build a client with the exact production
 * options against a deliberately tiny pool.
 */
export function clientOptionsFor(
  url: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Prisma.PrismaClientOptions {
  // No URL here means the env validator will fail the boot with a far better
  // message than a URL parse error would. Build the client the plain way and
  // let that happen.
  if (!url) return { ...testLog, transactionOptions: transactionOptionsFor(undefined, env) };
  const pooled = withPoolSettings(url, env);
  return {
    ...testLog,
    datasources: { db: { url: pooled } },
    transactionOptions: transactionOptionsFor(pooled, env),
  };
}

function createClient(): PrismaClient {
  return new PrismaClient(clientOptionsFor(process.env.DATABASE_URL));
}

// Reuse the client across `tsx watch` reloads so we don't exhaust DB
// connections during development.
export const prisma = globalThis.__rekeyPrisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__rekeyPrisma = prisma;
}
