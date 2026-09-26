/**
 * Run a body with the shared Prisma pool squeezed down to `free` usable
 * connections, by parking the rest in sleeping transactions.
 *
 * For proving that a request never needs a second connection while its
 * transaction holds the first. Code that reads or writes through the global
 * client inside `prisma.$transaction(async (tx) => ...)` does exactly that: on
 * a pool of N, N such requests each hold one connection and wait for another
 * until the 5 second transaction timeout fails them all. With one free
 * connection the deadlock is deterministic for a single request.
 */

import { clientOptionsFor, prisma } from '../src/lib/prisma.js';

/** Longer than the 5 second transaction timeout the deadlock runs into. */
const SLEEP_SECONDS = 8;

/** Worst case: every parked sleeper plus the body. Use as the test timeout. */
export const POOL_SQUEEZE_TEST_TIMEOUT_MS = 30_000;

function poolSize(): number {
  const options = clientOptionsFor(process.env.DATABASE_URL);
  const url = (options.datasources as { db: { url: string } }).db.url;
  return Number(new URL(url).searchParams.get('connection_limit'));
}

export async function withPoolOf<T>(free: number, body: () => Promise<T>): Promise<T> {
  const parked = poolSize() - free;
  const sleepers = Array.from({ length: parked }, () =>
    prisma.$transaction(async (tx) => tx.$queryRaw`SELECT pg_sleep(${SLEEP_SECONDS})::text`, {
      timeout: (SLEEP_SECONDS + 5) * 1000,
    }),
  );
  for (let i = 0; ; i++) {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND state = 'active' AND query LIKE 'SELECT pg_sleep%'`;
    if (Number(rows[0]!.n) >= parked) break;
    if (i > 400) throw new Error(`only ${rows[0]!.n} of ${parked} connections parked`);
    await new Promise((r) => setTimeout(r, 25));
  }
  try {
    return await body();
  } finally {
    await Promise.all(sleepers);
  }
}
