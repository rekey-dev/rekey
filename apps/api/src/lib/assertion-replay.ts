/**
 * Single-use enforcement for ID Token assertions.
 *
 * An operator assertion (POST /api/v1/tenant/auth/oidc/assert) travels through
 * the buyer's browser to get from the site that obtained it to the panel that
 * redeems it. It is signed and short-lived, but nothing in the OIDC ID Token
 * makes it single-use — there is no `jti` — so without this a token captured
 * in transit (browser history, a shared machine, an over-broad referrer) could
 * be replayed for the rest of its ten-minute life to mint another operator
 * session.
 *
 * The claim key is SHA-256 of the token, never the token: this store is not a
 * place a bearer credential should sit at rest.
 *
 * **Fail-CLOSED**, for the same reason `brute-force.ts` is: an unreachable
 * store must not silently downgrade a single-use credential to a replayable
 * one. A store error surfaces as 503 rather than as a successful sign-in.
 *
 * In tests (no Redis) an in-memory map backs the same logic, with expiry
 * honoured so the replay tests are deterministic without an external
 * dependency.
 */

import { createHash } from 'node:crypto';
import { getRedis } from './redis.js';

const KEY_PREFIX = 'assert:used:';

/** Expiry-aware in-memory fallback. Test-only — see the module docblock. */
const memory = new Map<string, number>();

function sweepMemory(now: number): void {
  for (const [k, expiresAt] of memory) {
    if (expiresAt <= now) memory.delete(k);
  }
}

/**
 * Claim this assertion, returning true if the caller is the FIRST to do so.
 *
 * A `false` return means the token has already been redeemed and this is a
 * replay. The claim is held until `expiresAtSec`, after which the token is
 * refused on its own `exp` anyway and the entry is dead weight — so the TTL is
 * exactly the token's remaining life, never longer.
 *
 * @throws when the store is unreachable. The caller must refuse the sign-in.
 */
export async function claimAssertionOnce(
  token: string,
  expiresAtSec: number,
): Promise<boolean> {
  const ttlSec = Math.ceil(expiresAtSec - Date.now() / 1000);
  // Already expired — the signature check will refuse it regardless, so there
  // is nothing to claim and no point storing a key with a non-positive TTL.
  if (ttlSec <= 0) return false;

  const key = KEY_PREFIX + createHash('sha256').update(token).digest('hex');
  const redis = getRedis();

  if (!redis) {
    const now = Date.now();
    sweepMemory(now);
    if (memory.has(key)) return false;
    memory.set(key, now + ttlSec * 1000);
    return true;
  }

  // SET NX is the atomic claim — two concurrent redemptions of the same token
  // cannot both win. Errors propagate (fail closed).
  const res = await redis.set(key, '1', 'EX', ttlSec, 'NX');
  return res === 'OK';
}

/** Test seam — drop every claim. */
export function __resetAssertionReplayForTests(): void {
  memory.clear();
}
