/**
 * Password hashing.
 *
 * Argon2id is the right primitive for *user-chosen* passwords — its memory-
 * hard cost defeats GPU brute force on weak inputs. (For our random API
 * tokens we use SHA-256 — see `lib/keys.ts` for why those are different.)
 *
 * Production keeps the `argon2` library defaults (memoryCost 64 MiB, timeCost
 * 3, parallelism 4) — within OWASP guidance; tune only against real hardware.
 *
 * **Test runtime only:** under the vitest runner (`process.env.VITEST`) we drop
 * to cheap params. The suite hashes a password on nearly every sign-up/sign-in;
 * at production cost that dominates CI wall-time (each hash ~tens of ms × memory
 * pressure on shared runners). The encoded hash still carries its own params, so
 * `verify` is unaffected and the algorithm under test is identical — only the
 * work factor changes, and ONLY in test. `VITEST` is never set in production.
 */

import argon2 from 'argon2';

const TYPE = argon2.argon2id;

// Cheap params ONLY when running under vitest. Never gated on NODE_ENV (which
// could be 'test' in a real deployment) — only the test runner sets VITEST.
const HASH_OPTIONS: argon2.Options = process.env.VITEST
  ? { type: TYPE, memoryCost: 4096, timeCost: 2, parallelism: 1 }
  : { type: TYPE };

/** Hash a plaintext password. Output is the encoded `$argon2id$...` string. */
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTIONS);
}

/**
 * Verify a plaintext password against an encoded hash. Returns `false` for
 * any failure — wrong password, malformed hash, missing hash. Never throws.
 */
export async function verifyPassword(hash: string | null, plain: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
