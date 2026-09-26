/**
 * Interactive transactions wait for a pooled connection as long as plain
 * queries do, and a pool that stays exhausted is a 503, not a 500.
 *
 * Prisma gives `$transaction` its own `maxWait` of 2 seconds, while a plain
 * query waits `pool_timeout` (10 seconds here). Sign-up, email verification,
 * session revoke, password change and the other writes that carry their
 * webhook rows in the same transaction therefore failed with P2028 under a
 * burst that a plain write would have queued through. lib/prisma.ts now
 * derives `maxWait` from the effective `pool_timeout`.
 *
 * The integration cases build a client from `clientOptionsFor`, the exact
 * options the shared client is built with, pointed at a pool of ONE
 * connection, and hold that connection busy with `pg_sleep`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { clientOptionsFor, transactionOptionsFor } from '../src/lib/prisma.js';
import { classifyDependencyOutage } from '../src/lib/dependency-outage.js';
import { rekeyErrorHandler } from '../src/lib/error.js';

function tinyPoolUrl(poolTimeoutSeconds: number): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('pool_timeout', String(poolTimeoutSeconds));
  return url.toString();
}

const clients: PrismaClient[] = [];
function tinyPoolClient(poolTimeoutSeconds: number): PrismaClient {
  const client = new PrismaClient(clientOptionsFor(tinyPoolUrl(poolTimeoutSeconds), {}));
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

/** Occupy the pool's only connection for `seconds`, inside a transaction. */
function holdTheConnection(client: PrismaClient, seconds: number): Promise<unknown> {
  return client.$transaction(async (tx) => tx.$queryRaw`SELECT pg_sleep(${seconds})::text`);
}

/** Resolve once the holder has actually checked the connection out. */
async function untilSleeping(): Promise<void> {
  const { prisma } = await import('../src/lib/prisma.js');
  for (let i = 0; i < 100; i++) {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND query LIKE 'SELECT pg_sleep%'`;
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the holder never started sleeping');
}

describe('transactionOptionsFor', () => {
  it('uses the pool_timeout the URL carries', () => {
    expect(transactionOptionsFor('postgresql://h/db_test?pool_timeout=7', {})).toEqual({
      maxWait: 7000,
      timeout: 5000,
    });
  });

  it('falls back to DATABASE_POOL_TIMEOUT_SECONDS, then to 10 seconds', () => {
    expect(transactionOptionsFor('postgresql://h/db_test', { DATABASE_POOL_TIMEOUT_SECONDS: '4' }).maxWait).toBe(4000);
    expect(transactionOptionsFor('postgresql://h/db_test', {}).maxWait).toBe(10_000);
    expect(transactionOptionsFor(undefined, {}).maxWait).toBe(10_000);
  });

  it('bounds a pool_timeout of 0 ("wait forever") instead of passing it through', () => {
    expect(transactionOptionsFor('postgresql://h/db_test?pool_timeout=0', {}).maxWait).toBe(10_000);
  });

  it('agrees with the pool_timeout withPoolSettings writes into the URL', () => {
    const options = clientOptionsFor('postgresql://h/db_test', { DATABASE_POOL_TIMEOUT_SECONDS: '12' });
    const url = new URL((options.datasources as { db: { url: string } }).db.url);
    expect(url.searchParams.get('pool_timeout')).toBe('12');
    expect(options.transactionOptions).toEqual({ maxWait: 12_000, timeout: 5000 });
  });
});

describe('a transaction behind a busy pool', () => {
  it('waits for the connection past Prisma\'s 2 second default instead of failing with P2028', async () => {
    const client = tinyPoolClient(8);
    const holder = holdTheConnection(client, 3);
    await untilSleeping();

    const started = Date.now();
    const result = await client.$transaction(async (tx) => tx.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`);
    const waited = Date.now() - started;

    expect(result).toEqual([{ ok: 1 }]);
    // It really did queue behind the holder, for longer than the old default.
    expect(waited).toBeGreaterThan(2_000);
    await holder;
  });
});

describe('an exhausted pool', () => {
  /** The real errors Prisma raises when the pool stays busy. */
  async function capturePoolErrors(): Promise<{ p2024: unknown; p2028: unknown }> {
    const client = tinyPoolClient(1);
    const holder = holdTheConnection(client, 3);
    await untilSleeping();
    const p2024 = await client.$queryRaw`SELECT 1`.then(() => null, (e: unknown) => e);
    const p2028 = await client
      .$transaction(async (tx) => tx.$queryRaw`SELECT 1`, { maxWait: 200 })
      .then(() => null, (e: unknown) => e);
    await holder;
    return { p2024, p2028 };
  }

  it('raises P2024 and P2028, and both classify as a Postgres outage', async () => {
    const { p2024, p2028 } = await capturePoolErrors();
    expect((p2024 as { code?: string }).code).toBe('P2024');
    expect((p2028 as { code?: string }).code).toBe('P2028');
    expect(classifyDependencyOutage(p2024)).toBe('postgres');
    expect(classifyDependencyOutage(p2028)).toBe('postgres');
  });

  it('answers 503 DEPENDENCY_UNAVAILABLE with Retry-After, not a generic 500', async () => {
    const { p2024, p2028 } = await capturePoolErrors();
    const app = Fastify({ logger: false });
    app.setErrorHandler(rekeyErrorHandler);
    app.get('/p2024', async () => { throw p2024; });
    app.get('/p2028', async () => { throw p2028; });
    await app.ready();
    try {
      for (const url of ['/p2024', '/p2028']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(503);
        expect((res.json() as { error: { code: string } }).error.code).toBe('DEPENDENCY_UNAVAILABLE');
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      }
    } finally {
      await app.close();
    }
  });

  // The database itself is up in both cases, so "the PostgreSQL database is
  // unreachable ... restore the failed dependency" was false for both, and
  // sent the operator to fix something that was up.
  it('says the pool was busy, or the transaction timed out, never that the database is unreachable', async () => {
    const { p2024, p2028 } = await capturePoolErrors();
    // A transaction that got its connection and then ran past its `timeout`.
    const client = tinyPoolClient(8);
    const overran = await client
      .$transaction(async (tx) => tx.$queryRaw`SELECT pg_sleep(1)::text`, { timeout: 200 })
      .then(() => null, (e: unknown) => e);
    expect((overran as { code?: string }).code).toBe('P2028');

    const app = Fastify({ logger: false });
    app.setErrorHandler(rekeyErrorHandler);
    app.get('/p2024', async () => { throw p2024; });
    app.get('/p2028-wait', async () => { throw p2028; });
    app.get('/p2028-timeout', async () => { throw overran; });
    app.get('/p1001', async () => { throw Object.assign(new Error('down'), { code: 'P1001' }); });
    await app.ready();
    type Body = { error: { code: string; message: string; fix: string; details?: { reason?: string } } };
    try {
      for (const [url, reason] of [
        ['/p2024', 'pool_busy'],
        ['/p2028-wait', 'pool_busy'],
        ['/p2028-timeout', 'transaction_timeout'],
      ] as const) {
        const res = await app.inject({ method: 'GET', url });
        const { error } = res.json() as Body;
        expect(res.statusCode, url).toBe(503);
        expect(error.code, url).toBe('DEPENDENCY_UNAVAILABLE');
        expect(error.details?.reason, url).toBe(reason);
        expect(error.message, url).not.toMatch(/unreachable/i);
        expect(error.fix, url).not.toMatch(/restore the failed dependency/i);
        // /health/ready probes through the same pool (routes/health.ts), so
        // under saturation it can fail too: the pool_busy text must not
        // promise it stays green.
        if (reason === 'pool_busy') {
          expect(error.fix, url).toMatch(/health\/ready checks through the same pool/);
          expect(error.fix, url).toMatch(/can also report `db` unreachable/);
          expect(error.fix, url).not.toMatch(/report `db` ok/);
        } else {
          expect(error.fix, url).toMatch(/health\/ready can report `db` ok/);
        }
      }
      expect((await app.inject({ method: 'GET', url: '/p2024' })).json().error.message).toMatch(/pool stayed busy/);
      expect((await app.inject({ method: 'GET', url: '/p2028-timeout' })).json().error.message).toMatch(
        /ran past its time limit/,
      );
      // A dead server keeps the outage text and carries no reason.
      const down = (await app.inject({ method: 'GET', url: '/p1001' })).json() as Body;
      expect(down.error.message).toMatch(/PostgreSQL database is unreachable/);
      expect(down.error.details).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
