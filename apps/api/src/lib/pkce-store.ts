/**
 * Hold a PKCE verifier across the provider redirect.
 *
 * The verifier is generated when we build the authorization URL and has to be
 * presented, unchanged, at the token exchange — but a full browser round-trip
 * to the identity provider happens in between. Something has to remember it.
 *
 * **It is stored server-side, keyed by the CSRF `state`, and never given to the
 * browser.** Handing the verifier to the client would undo the point of PKCE:
 * the whole mechanism rests on the exchange proving possession of a secret the
 * intercepted redirect did not carry. A cookie would be a smaller mistake than
 * a query parameter, and still a mistake.
 *
 * Single-use: `take` deletes as it reads, so a replayed callback finds nothing
 * and the exchange fails. The TTL matches how long a human plausibly spends on
 * a consent screen; an abandoned flow expires rather than accumulating.
 *
 * Falls back to process memory when Redis is absent, matching
 * `assertion-replay.ts`. That is correct for a single-replica self-host and for
 * tests; across replicas an unlucky operator lands on a node that never saw the
 * start of their flow and is asked to sign in again. Redis removes that, which
 * is why hosted deployments require it at boot.
 */

import { getRedis } from './redis.js';

const KEY_PREFIX = 'oauth:pkce:';

/** Long enough for a consent screen and a password manager, short enough to be forgettable. */
const TTL_SECONDS = 10 * 60;

/** Redis-less fallback: verifier by key, with its own expiry. */
const memory = new Map<string, { verifier: string; expiresAt: number }>();

function sweepMemory(now: number): void {
  for (const [k, v] of memory) if (v.expiresAt <= now) memory.delete(k);
}

/**
 * `state` is the key, not part of the value: it is already unguessable (the
 * panel mints it per flow) and already round-tripped, so it identifies the flow
 * without inventing a second identifier to carry.
 */
function keyFor(state: string): string {
  return KEY_PREFIX + state;
}

export async function rememberVerifier(state: string, verifier: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    sweepMemory(Date.now());
    memory.set(keyFor(state), { verifier, expiresAt: Date.now() + TTL_SECONDS * 1000 });
    return;
  }
  await redis.set(keyFor(state), verifier, 'EX', TTL_SECONDS);
}

/**
 * Read and delete. Returns null when the flow is unknown, already completed, or
 * expired — all of which are the same thing to the caller: there is no verifier
 * to present, so an exchange that needs one must fail rather than proceed
 * without it.
 */
export async function takeVerifier(state: string): Promise<string | null> {
  const key = keyFor(state);
  const redis = getRedis();
  if (!redis) {
    sweepMemory(Date.now());
    const hit = memory.get(key);
    memory.delete(key);
    return hit ? hit.verifier : null;
  }
  // GETDEL is the atomic take — two concurrent callbacks for one state cannot
  // both come away with the verifier.
  const value = await redis.getdel(key);
  return value ?? null;
}

/** Test seam — drop every stored verifier. */
export function __resetPkceStoreForTests(): void {
  memory.clear();
}
