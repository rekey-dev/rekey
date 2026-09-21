/**
 * Imported bcrypt hashes verify on worker threads (issue #511). These pin the
 * three things that matter: the answer is still right, the event loop stays
 * free while a real-cost compare runs, and a saturated pool refuses with a
 * 503 instead of answering or queuing without bound.
 */

import { afterAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { RekeyError } from '../src/lib/error.js';
import {
  BCRYPT_POOL_CAPACITY,
  bcryptPoolWorkerCount,
  shutdownBcryptPool,
} from '../src/lib/bcrypt-pool.js';
import { MAX_BCRYPT_COST, verifyPassword, verifyPasswordOrDecoy } from '../src/lib/passwords.js';

const PASSWORD = 'pw-one-two-three';

describe('bcrypt worker pool', () => {
  afterAll(async () => {
    await shutdownBcryptPool();
  });

  it('verifies correct and wrong passwords through the pool', async () => {
    const bc = await bcrypt.hash(PASSWORD, 4);
    expect(await verifyPassword(bc, PASSWORD)).toBe(true);
    expect(await verifyPassword(bc, 'wrong')).toBe(false);
    expect(bcryptPoolWorkerCount()).toBeGreaterThan(0);
    // A bcrypt-shaped string that is not a real hash still answers false.
    expect(await verifyPassword('$2b$04$' + '.'.repeat(53), PASSWORD)).toBe(false);
    // An absent account still goes through the argon2 decoy, not the pool.
    expect(await verifyPasswordOrDecoy(null, PASSWORD)).toBe(false);
  });

  it('does not block the event loop while a cost-12 compare runs', async () => {
    const bc = bcrypt.hashSync(PASSWORD, MAX_BCRYPT_COST);
    // Warm the pool so worker start-up is not what is being measured.
    await verifyPassword(bc, 'warm-up');

    let maxGap = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    const started = performance.now();
    const ok = await verifyPassword(bc, PASSWORD);
    const elapsed = performance.now() - started;
    clearInterval(probe);

    expect(ok).toBe(true);
    // Sanity: the compare took real time, so a free loop is meaningful.
    expect(elapsed).toBeGreaterThan(50);
    // Inline bcryptjs blocks in ~100 ms slices; off the loop, a 5 ms timer
    // fires on time. Generous for a loaded CI runner.
    expect(maxGap).toBeLessThan(60);
  });

  it('completes many concurrent verifies with the right answers', async () => {
    const bc = await bcrypt.hash(PASSWORD, 4);
    const n = BCRYPT_POOL_CAPACITY;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => verifyPassword(bc, i % 2 === 0 ? PASSWORD : `wrong-${i}`)),
    );
    expect(results).toEqual(Array.from({ length: n }, (_, i) => i % 2 === 0));
  });

  it('refuses with a 503 beyond capacity, and never answers true for a wrong password', async () => {
    const bc = await bcrypt.hash(PASSWORD, 4);
    const overflow = 5;
    const settled = await Promise.allSettled(
      Array.from({ length: BCRYPT_POOL_CAPACITY + overflow }, () => verifyPassword(bc, 'wrong')),
    );
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(fulfilled).toHaveLength(BCRYPT_POOL_CAPACITY);
    for (const f of fulfilled) expect((f as PromiseFulfilledResult<boolean>).value).toBe(false);
    expect(rejected).toHaveLength(overflow);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(RekeyError);
      expect((r.reason as RekeyError).statusCode).toBe(503);
      expect((r.reason as RekeyError).code).toBe('PASSWORD_VERIFY_BUSY');
    }

    // Once drained, the pool accepts work again.
    expect(await verifyPassword(bc, PASSWORD)).toBe(true);
  });

  it('shuts down, and starts again lazily on the next compare', async () => {
    const bc = await bcrypt.hash(PASSWORD, 4);
    await verifyPassword(bc, PASSWORD);
    await shutdownBcryptPool();
    expect(bcryptPoolWorkerCount()).toBe(0);
    expect(await verifyPassword(bc, PASSWORD)).toBe(true);
    expect(bcryptPoolWorkerCount()).toBeGreaterThan(0);
    await shutdownBcryptPool();
    expect(bcryptPoolWorkerCount()).toBe(0);
  });

  it('a compare whose worker goes away rejects without a verdict, never false or true', async () => {
    const bc = bcrypt.hashSync(PASSWORD, MAX_BCRYPT_COST);
    await verifyPassword(bc, 'warm-up');
    // One running per worker plus some queued, then pull the workers out.
    const pending = Array.from({ length: BCRYPT_POOL_CAPACITY }, () =>
      verifyPassword(bc, PASSWORD).then(
        (v) => ({ verdict: v }),
        (e: unknown) => ({ error: e }),
      ),
    );
    await shutdownBcryptPool();
    const outcomes = await Promise.all(pending);
    for (const o of outcomes) {
      expect(o).not.toHaveProperty('verdict');
      const err = (o as { error: unknown }).error;
      expect(err).toBeInstanceOf(RekeyError);
      expect((err as RekeyError).statusCode).toBe(500);
    }
    // And the pool recovers.
    expect(await verifyPassword(bc, PASSWORD)).toBe(true);
  });
});
