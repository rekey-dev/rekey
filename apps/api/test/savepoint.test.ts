/**
 * `withSavepoint` against a real transaction, plus the one path a real
 * database will not produce on demand: the ROLLBACK TO SAVEPOINT itself
 * failing. The caller branches on the STEP's error (a P2002 it knows how to
 * recover from), so that is the error that must come out, with the rollback
 * failure attached as its cause rather than replacing it.
 */

import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { withSavepoint } from '../src/lib/savepoint.js';

describe('withSavepoint', () => {
  it('rolls back only the failed step and leaves the transaction usable', async () => {
    const seen = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`CREATE TEMP TABLE sp_probe (n int PRIMARY KEY) ON COMMIT DROP`;
      await tx.$executeRaw`INSERT INTO sp_probe VALUES (1)`;
      const failure = await withSavepoint(tx, () => tx.$executeRaw`INSERT INTO sp_probe VALUES (1)`).then(
        () => null,
        (e: unknown) => e,
      );
      expect((failure as { code?: string }).code).toBe('P2010');
      return tx.$queryRaw<Array<{ n: number }>>`SELECT n FROM sp_probe`;
    });
    expect(seen).toEqual([{ n: 1 }]);
  });

  it('keeps the step error when the rollback to the savepoint also fails', async () => {
    const stepError = Object.assign(new Error('unique violation'), { code: 'P2002' });
    const rollbackError = new Error('connection lost during rollback');
    const tx = {
      $executeRaw: (strings: TemplateStringsArray) =>
        strings[0]!.startsWith('ROLLBACK') ? Promise.reject(rollbackError) : Promise.resolve(0),
    } as unknown as Prisma.TransactionClient;

    const thrown = await withSavepoint(tx, () => Promise.reject(stepError)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBe(stepError);
    expect((thrown as Error).cause).toBe(rollbackError);
  });
});
