/**
 * API key generation + verification.
 *
 * Two key formats:
 *
 *   - **Public key** (browser-safe): `rp_pub_<slug>_<random16>`
 *     One per Application. Shipped to the browser by `@relipay/react`. The
 *     SDK uses it to call public, unauthenticated-from-server endpoints
 *     (sign-in widgets, plan listing, etc.).
 *
 *   - **Secret key** (server-only): `rp_<live|test>_<random32>`
 *     Many per Application. Used by `@relipay/node` for trusted server-side
 *     calls. Stored as SHA-256 hash; the raw key is shown to the user
 *     exactly once at creation.
 *
 * Why SHA-256 and not Argon2? API keys are high-entropy random tokens, not
 * user-chosen passwords. The risk model is "DB leak" not "online brute
 * force." A fast hash is correct here. (Argon2 is right for passwords; SHA-256
 * is right for tokens.)
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PUBLIC_KEY_PREFIX = 'rp_pub';
const SECRET_KEY_LIVE_PREFIX = 'rp_live';
const SECRET_KEY_TEST_PREFIX = 'rp_test';

/** Cryptographically random URL-safe string of the requested byte length. */
function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Generate a public key for an Application. Embeds the slug so a leaked key
 * is identifiable at a glance.
 *
 * @example
 * ```ts
 * generatePublicKey('myapp-prod') // → "rp_pub_myapp-prod_a8f3..."
 * ```
 */
export function generatePublicKey(slug: string): string {
  return `${PUBLIC_KEY_PREFIX}_${slug}_${randomToken(12)}`;
}

/**
 * Generate a secret API key. Returns the raw key (show to user once) and
 * the SHA-256 hash (store in DB).
 *
 * @param mode `"live"` for production keys, `"test"` for sandbox keys.
 *
 * @example
 * ```ts
 * const { raw, hash, prefix } = generateSecretKey('live');
 * // raw    → "rp_live_oQa9k...32-byte-token..."  ← give to user, never store
 * // hash   → "5b2d…"                              ← store this
 * // prefix → "rp_live_oQa9"                       ← show in lists for identification
 * ```
 */
export function generateSecretKey(mode: 'live' | 'test'): {
  raw: string;
  hash: string;
  prefix: string;
} {
  const prefix = mode === 'live' ? SECRET_KEY_LIVE_PREFIX : SECRET_KEY_TEST_PREFIX;
  const raw = `${prefix}_${randomToken(24)}`;
  const hash = hashKey(raw);
  // First 12 chars of the secret portion, for UI list display.
  const displayPrefix = raw.slice(0, prefix.length + 1 + 4);
  return { raw, hash, prefix: displayPrefix };
}

/** SHA-256 hash, hex-encoded. Stable, not salted — keys are high-entropy. */
export function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Constant-time comparison of two pre-hashed keys. Use this when verifying a
 * presented key against a stored hash — never `===`, which leaks length and
 * prefix-match timing.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** True if the value looks like one of our key formats. Cheap pre-filter. */
export function isRelipayKey(value: string): boolean {
  return (
    value.startsWith(`${PUBLIC_KEY_PREFIX}_`) ||
    value.startsWith(`${SECRET_KEY_LIVE_PREFIX}_`) ||
    value.startsWith(`${SECRET_KEY_TEST_PREFIX}_`)
  );
}
