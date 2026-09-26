/**
 * argon2 runs on libuv's threadpool, which also resolves hostnames for every
 * outbound call. The image sets UV_THREADPOOL_SIZE=16 and passwords.ts keeps
 * hashing to ARGON2_CONCURRENCY of those threads, so a burst of sign-ins can
 * neither starve DNS nor multiply argon2's 64 MiB-per-hash memory.
 */

import { describe, expect, it } from 'vitest';
import { ARGON2_CONCURRENCY, argon2Load, hashPassword, verifyPassword } from '../src/lib/passwords.js';

describe('argon2 concurrency gate', () => {
  it('never runs more than ARGON2_CONCURRENCY hashes at once, and finishes every job', async () => {
    let peak = 0;
    const jobs = Array.from({ length: ARGON2_CONCURRENCY * 4 }, (_, i) => hashPassword(`pw-${i}`));
    const sampler = setInterval(() => {
      peak = Math.max(peak, argon2Load().running);
    }, 0);
    // Right after queueing, the gate is full and the rest are waiting.
    expect(argon2Load()).toEqual({ running: ARGON2_CONCURRENCY, waiting: ARGON2_CONCURRENCY * 3 });
    const hashes = await Promise.all(jobs);
    clearInterval(sampler);

    expect(peak).toBeLessThanOrEqual(ARGON2_CONCURRENCY);
    expect(argon2Load()).toEqual({ running: 0, waiting: 0 });
    expect(await verifyPassword(hashes[5]!, 'pw-5')).toBe(true);
    expect(await verifyPassword(hashes[5]!, 'pw-6')).toBe(false);
  });

  it('releases the slot when a job fails', async () => {
    // A string that is no hash at all makes argon2.verify throw inside the gate.
    const results = await Promise.all(
      Array.from({ length: ARGON2_CONCURRENCY * 2 }, () => verifyPassword('not-a-hash-at-all', 'x')),
    );
    expect(results.every((r) => r === false)).toBe(true);
    expect(argon2Load()).toEqual({ running: 0, waiting: 0 });
  });
});
