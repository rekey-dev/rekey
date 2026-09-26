/**
 * Run one step of an interactive transaction so that its failure can be
 * recovered from inside the same transaction.
 *
 * Postgres aborts the whole transaction on the first failed statement: every
 * later query answers `25P02 current transaction is aborted` until it rolls
 * back. So the familiar "create, and on P2002 read the winner's row" recovery
 * cannot run inside `prisma.$transaction(async (tx) => ...)`, the read fails
 * and the request answers 500. Prisma's nested `$transaction` does not create
 * a savepoint, so this one is issued by hand.
 *
 * On failure the transaction is rolled back to the state it had before `step`
 * and the step's error is rethrown for the caller to inspect. Everything the
 * transaction did earlier (a consumed token, a locked row) is kept.
 */

import type { Prisma } from '@prisma/client';

export async function withSavepoint<T>(
  tx: Prisma.TransactionClient,
  step: () => Promise<T>,
): Promise<T> {
  await tx.$executeRaw`SAVEPOINT recoverable_step`;
  let result: T;
  try {
    result = await step();
  } catch (e) {
    try {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT recoverable_step`;
    } catch (rollbackError) {
      // The step's error is the one the caller branches on (a P2002 it knows
      // how to recover from, say), so it is the one thrown. The rollback
      // failure rides along as its cause for the log; the transaction is
      // unusable either way and the caller's next query will say so.
      if (e instanceof Error && e.cause === undefined) {
        e.cause = rollbackError;
      }
    }
    throw e;
  }
  await tx.$executeRaw`RELEASE SAVEPOINT recoverable_step`;
  return result;
}
