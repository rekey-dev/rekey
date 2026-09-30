/**
 * Run dashboard reads in a READ ONLY transaction with a statement timeout.
 *
 * A dashboard query that grows with an Application's size must end in a
 * bounded time and must never write. The timeout is `SET LOCAL`, so it dies
 * with the transaction and never leaks onto a pooled connection that a
 * sign-in picks up next.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import type { RekeyError } from './error.js';

export const DEFAULT_STATEMENT_TIMEOUT_MS = 4_000;

export interface ReadBudget {
  statementTimeoutMs?: number;
  /** The error a timed-out statement becomes. */
  onTimeout: () => RekeyError;
}

const STATEMENT_TIMEOUT_SQLSTATE = '57014';

/**
 * All settings in one round trip, transaction-local. Turning a transaction
 * read-only is allowed at any point in it; only turning it back is refused.
 * JIT is off: the dashboard aggregates carry dozens of expressions, and on a
 * 500k-user app JIT compilation took the activity section from 4 s to 11 s.
 */
export const READ_ONLY_BUDGET_SQL =
  "SELECT set_config('statement_timeout', $1, true), set_config('transaction_read_only', 'on', true), set_config('jit', 'off', true)";

/**
 * True for a Postgres statement timeout or a Prisma interactive transaction
 * that outlived its own timeout.
 *
 * @example
 *   if (isQueryTimeout(err)) throw timeoutError();
 */
export function isQueryTimeout(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  if (e.code === 'P2028') return true;
  if (e.meta?.code === STATEMENT_TIMEOUT_SQLSTATE) return true;
  return typeof e.message === 'string' && e.message.includes('canceling statement due to statement timeout');
}

/**
 * @example
 *   const rows = await withReadOnlyBudget(
 *     (tx) => tx.$queryRaw`SELECT count(*) FROM end_users WHERE application_id = ${id}`,
 *     { onTimeout: () => statsTimeout() },
 *   );
 */
export async function withReadOnlyBudget<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  budget: ReadBudget,
): Promise<T> {
  const ms = Math.trunc(budget.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS);
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(READ_ONLY_BUDGET_SQL, String(ms));
        return work(tx);
      },
      { maxWait: 2_000, timeout: ms + 2_000 },
    );
  } catch (err) {
    if (isQueryTimeout(err)) throw budget.onTimeout();
    throw err;
  }
}
