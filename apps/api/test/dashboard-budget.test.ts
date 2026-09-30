/**
 * The dashboard compute budget: at most N computations at once per process
 * (`lib/compute-semaphore.ts`), and every one read-only under a statement
 * timeout (`lib/read-budget.ts`).
 */

import { describe, expect, it } from 'vitest';
import { createSemaphore, dashboardBusy } from '../src/lib/compute-semaphore.js';
import { withReadOnlyBudget } from '../src/lib/read-budget.js';
import { RekeyError } from '../src/lib/error.js';
import { prisma } from '../src/lib/prisma.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const timeoutError = (): RekeyError =>
  new RekeyError({ statusCode: 503, code: 'ANALYTICS_TIMEOUT', message: 'slow', fix: 'Narrow the range.' });

describe('compute semaphore', () => {
  it('never runs more than `max` at once across 8 racers', async () => {
    const slots = createSemaphore({ max: 2, waitMs: 5_000, busy: dashboardBusy });
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        slots.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await sleep(20);
          running -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(slots.active).toBe(0);
    expect(slots.waiting).toBe(0);
  });

  it('a waiter that cannot start in time gets 503 ANALYTICS_BUSY with Retry-After', async () => {
    const slots = createSemaphore({ max: 1, waitMs: 50, busy: dashboardBusy });
    let release!: () => void;
    const hold = slots.run(() => new Promise<void>((r) => (release = r)));
    const err = await slots.run(async () => 'never').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RekeyError);
    expect(err).toMatchObject({ statusCode: 503, code: 'ANALYTICS_BUSY', retryAfterSeconds: 5 });
    expect(slots.waiting).toBe(0);
    release();
    await hold;
    expect(await slots.run(async () => 'next')).toBe('next');
  });

  it('a failing computation frees its slot', async () => {
    const slots = createSemaphore({ max: 1, waitMs: 50, busy: dashboardBusy });
    await expect(slots.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await slots.run(async () => 'ok')).toBe('ok');
  });
});

describe('read-only budget', () => {
  it('turns a statement over the budget into the caller-supplied error', async () => {
    const err = await withReadOnlyBudget((tx) => tx.$queryRaw`SELECT pg_sleep(1)`, {
      statementTimeoutMs: 100,
      onTimeout: timeoutError,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ANALYTICS_TIMEOUT', statusCode: 503 });
  });

  it('refuses writes', async () => {
    const err = await withReadOnlyBudget(
      (tx) => tx.$executeRaw`CREATE TEMP TABLE budget_probe (x int)`,
      { onTimeout: timeoutError },
    ).catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(/read-only transaction/);
  });

  it('applies the timeout to the transaction only', async () => {
    const inside = await withReadOnlyBudget(
      (tx) => tx.$queryRaw<Array<{ t: string }>>`SELECT current_setting('statement_timeout') AS t`,
      { statementTimeoutMs: 1234, onTimeout: timeoutError },
    );
    expect(inside[0]?.t).toBe('1234ms');
    const jit = await withReadOnlyBudget(
      (tx) => tx.$queryRaw<Array<{ j: string }>>`SELECT current_setting('jit') AS j`,
      { onTimeout: timeoutError },
    );
    expect(jit[0]?.j).toBe('off');
    const after = await prisma.$transaction(
      (tx) => tx.$queryRaw<Array<{ t: string }>>`SELECT current_setting('statement_timeout') AS t`,
    );
    expect(after[0]?.t).toBe('0');
  });
});
