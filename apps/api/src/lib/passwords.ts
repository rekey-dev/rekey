/**
 * Password hashing.
 *
 * Argon2id is the right primitive for *user-chosen* passwords, its memory-
 * hard cost defeats GPU brute force on weak inputs. (For our random API
 * tokens we use SHA-256, see `lib/keys.ts` for why those are different.)
 *
 * Production keeps the `argon2` library defaults (memoryCost 64 MiB, timeCost
 * 3, parallelism 4), within OWASP guidance; tune only against real hardware.
 *
 * **Test runtime only:** under the vitest runner (`process.env.VITEST`) we drop
 * to cheap params. The suite hashes a password on nearly every sign-up/sign-in;
 * at production cost that dominates CI wall-time (each hash ~tens of ms × memory
 * pressure on shared runners). The encoded hash still carries its own params, so
 * `verify` is unaffected and the algorithm under test is identical, only the
 * work factor changes, and ONLY in test. `VITEST` is never set in production.
 */

import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { bcryptCompare } from './bcrypt-pool.js';
import { RekeyError } from './error.js';

const TYPE = argon2.argon2id;

// Cheap params ONLY when running under vitest. Never gated on NODE_ENV (which
// could be 'test' in a real deployment), only the test runner sets VITEST.
const HASH_OPTIONS: argon2.Options = process.env.VITEST
  ? { type: TYPE, memoryCost: 4096, timeCost: 2, parallelism: 1 }
  : { type: TYPE };

/** Hash a plaintext password. Output is the encoded `$argon2id$...` string. */
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTIONS);
}

/**
 * A bcrypt hash as produced by every mainstream bcrypt library (`$2a$`,
 * `$2b$`, `$2y$`). Rekey never CREATES these, `hashPassword` is argon2id
 * only, but it accepts them at verify time so an application migrating its
 * users from another auth system can import the hashes it already holds and
 * let each user keep their password. The first successful sign-in re-hashes
 * to argon2id (`needsRehash`), so the bcrypt hash lives exactly as long as it
 * has to.
 */
const BCRYPT_RE = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

/**
 * The most expensive bcrypt an imported hash may carry. Cost is a power of
 * two, so 12 is 4 096 rounds, above the default of every mainstream bcrypt
 * library. `bcryptjs` is pure JavaScript (run on a worker thread, see
 * `bcrypt-pool.ts`), and a hash at cost 31 would hold that worker for hours
 * per attempt: the import route
 * is a secret-key surface, so without a ceiling any tenant could turn their
 * own sign-in into a CPU sink for the deployment.
 */
export const MAX_BCRYPT_COST = 12;

/**
 * Ceilings on the argon2id parameters an imported hash may carry. The same
 * hole the bcrypt cost closes, in the other primitive: `argon2.verify` runs
 * with whatever `m`, `t` and `p` the encoded string names, so a hash
 * declaring four gigabytes and sixty-four lanes would have every sign-in
 * attempt for that address allocate four gigabytes before answering false.
 * 256 MiB is four times the production default; 10 passes and 8 lanes are
 * well above anything OWASP recommends.
 */
export const MAX_ARGON2_MEMORY_KIB = 262_144;
export const MAX_ARGON2_TIME_COST = 10;
export const MAX_ARGON2_PARALLELISM = 8;

/** A full PHC-format argon2id string, the only argon2 shape Rekey accepts. */
const ARGON2ID_RE = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

/** The argon2id parameters of a hash, or null when it is not a well-formed one. */
export function argon2Params(hash: string): { memoryKib: number; timeCost: number; parallelism: number } | null {
  const m = ARGON2ID_RE.exec(hash);
  if (!m) return null;
  return { memoryKib: Number(m[1]), timeCost: Number(m[2]), parallelism: Number(m[3]) };
}

function argon2WithinBudget(hash: string): boolean {
  const p = argon2Params(hash);
  return (
    p !== null &&
    p.memoryKib <= MAX_ARGON2_MEMORY_KIB &&
    p.timeCost <= MAX_ARGON2_TIME_COST &&
    p.parallelism <= MAX_ARGON2_PARALLELISM
  );
}

export function isBcryptHash(hash: string): boolean {
  return BCRYPT_RE.test(hash);
}

/** The cost factor of a bcrypt hash, or null when it is not one. */
export function bcryptCost(hash: string): number | null {
  const m = BCRYPT_RE.exec(hash);
  return m ? Number(m[1]) : null;
}

/**
 * Whether a hash may be STORED for later verification: a well-formed argon2id
 * PHC string, or a well-formed bcrypt hash at a cost this deployment is
 * willing to pay at sign-in. The import route asks this per row so a
 * malformed hash is refused up front instead of stored as a password that
 * can never verify.
 */
export function isSupportedPasswordHash(hash: string): boolean {
  if (hash.startsWith('$argon2id$')) return argon2WithinBudget(hash);
  const cost = bcryptCost(hash);
  return cost !== null && cost <= MAX_BCRYPT_COST;
}

/**
 * True when a hash that just verified should be replaced with a fresh
 * argon2id one. Today that means "it was bcrypt". Callers re-hash with
 * `hashPassword` and store the result; the plaintext is in hand at exactly
 * that moment and never again.
 */
export function needsRehash(hash: string): boolean {
  return isBcryptHash(hash);
}

/**
 * Verify a plaintext password against an encoded hash. Returns `false` for
 * any failure, wrong password, malformed hash, missing hash.
 *
 * Throws only when a bcrypt hash reached no verdict (see `bcrypt-pool.ts`):
 * a 503 `PASSWORD_VERIFY_BUSY` RekeyError when the worker pool is full, a 500
 * when a worker failed. That is deliberately not a `false`: the password was
 * never checked, so it must neither be reported as wrong nor counted as a
 * failed attempt.
 *
 * Returns *immediately* when there is no hash. That is correct for a caller
 * that already knows the account exists, and an account-existence oracle for
 * one that does not, see `verifyPasswordOrDecoy`.
 */
export async function verifyPassword(hash: string | null, plain: string): Promise<boolean> {
  if (!hash) return false;
  try {
    if (isBcryptHash(hash)) {
      // Belt and braces for a row that predates the import ceiling.
      if ((bcryptCost(hash) ?? Infinity) > MAX_BCRYPT_COST) return false;
      return await bcryptCompare(plain, hash);
    }
    // Rekey's own hashes are always within budget; an imported one that is
    // not was refused at import, so this only ever refuses a row written
    // before the ceiling existed. Refusing is the point: the verify would
    // otherwise honour whatever the string asks for.
    if (hash.startsWith('$argon2id$') && !argon2WithinBudget(hash)) return false;
    return await argon2.verify(hash, plain);
  } catch (err) {
    if (err instanceof RekeyError) throw err;
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
 * account", and `verifyPassword` answers that in microseconds while a real
 * account costs a full argon2id verification. That difference is measurable
 * over the network (9.0 ms vs 3.3 ms against the operator sign-in endpoint, no
 * overlap between the two distributions), which turns an unauthenticated
 * endpoint into an account-existence oracle regardless of how carefully the
 * response body is flattened.
 *
 * So the absent-hash branch verifies against a decoy instead of returning
 * early. The answer is always `false`; the point is that it costs the same.
 *
 * This is not a claim of constant time in the cryptographic sense, argon2's
 * own runtime varies, and so does everything else on the request path. It
 * removes the one difference that was an order of magnitude wide and perfectly
 * separable.
 */
export async function verifyPasswordOrDecoy(hash: string | null, plain: string): Promise<boolean> {
  if (hash) return verifyPassword(hash, plain);
  await verifyPassword(await decoy(), plain);
  return false;
}
