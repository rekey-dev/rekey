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

  it('bounds a pool_timeout of 0 ("wait forever") instead of passing it through', () => {
    expect(transactionOptionsFor('postgresql://h/db_test?pool_timeout=0', {}).maxWait).toBe(10_000);
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
});
