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

import { randomBytes } from 'node:crypto';
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
 *
 * Returns *immediately* when there is no hash. That is correct for a caller
 * that already knows the account exists, and an account-existence oracle for
 * one that does not — see `verifyPasswordOrDecoy`.
 */
export async function verifyPassword(hash: string | null, plain: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * A real argon2id hash of a value nobody can present, used as the verification
 * target when the account does not exist.
 *
 * Built once, lazily, from 32 random bytes: the plaintext is never retained, so
 * no input can verify against it. Lazy because hashing at module load would add
 * the full argon2 cost to process start (and to every test file's import), and
 * the overwhelming majority of sign-ins are for accounts that DO exist and
 * never touch it.
 */
let decoyHash: Promise<string> | null = null;
function decoy(): Promise<string> {
  decoyHash ??= argon2.hash(randomBytes(32).toString('hex'), HASH_OPTIONS);
  return decoyHash;
}

/**
 * Verify a password, doing the same argon2 work whether or not the account
 * exists.
 *
 * Sign-in reads the account row first, so `hash === null` means "no such
 * account" — and `verifyPassword` answers that in microseconds while a real
 * account costs a full argon2id verification. That difference is measurable
 * over the network (9.0 ms vs 3.3 ms against the operator sign-in endpoint, no
 * overlap between the two distributions), which turns an unauthenticated
 * endpoint into an account-existence oracle regardless of how carefully the
 * response body is flattened.
 *
 * So the absent-hash branch verifies against a decoy instead of returning
 * early. The answer is always `false`; the point is that it costs the same.
 *
 * This is not a claim of constant time in the cryptographic sense — argon2's
 * own runtime varies, and so does everything else on the request path. It
 * removes the one difference that was an order of magnitude wide and perfectly
 * separable.
 */
export async function verifyPasswordOrDecoy(hash: string | null, plain: string): Promise<boolean> {
  if (hash) return verifyPassword(hash, plain);
  await verifyPassword(await decoy(), plain);
  return false;
}
