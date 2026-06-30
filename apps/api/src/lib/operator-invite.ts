/**
 * Operator-invite key helpers (OPERATOR_SIGNUP_MODE='invite').
 *
 * A single-use key the super-admin mints to authorize the creation of ONE new
 * operator + workspace when self-serve sign-up is gated. Distinct from
 * `tenant-invitations.ts` (which joins an existing workspace).
 *
 * Hash-only: only the SHA-256 of the raw key is persisted. The raw key is
 * shown to the super-admin exactly once at mint and encoded into whatever
 * channel they hand it to the new operator on.
 */

import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
/** Recognizable, greppable prefix on the raw key. */
export const OPERATOR_INVITE_PREFIX = 'rp_opinv';

export interface GeneratedOperatorInvite {
  /** The full raw key — shown exactly once, never stored. */
  raw: string;
  /** SHA-256(raw), hex. Persisted as `tokenHash`. */
  hash: string;
  /** First chars of the raw key, for admin list display (not the secret). */
  prefix: string;
}

export function generateOperatorInviteToken(): GeneratedOperatorInvite {
  const raw = `${OPERATOR_INVITE_PREFIX}_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  const hash = hashOperatorInviteToken(raw);
  // Prefix = `rp_opinv_` + first 6 random chars. Enough to disambiguate a row
  // in the admin list without revealing material entropy.
  const prefix = raw.slice(0, OPERATOR_INVITE_PREFIX.length + 1 + 6);
  return { raw, hash, prefix };
}

/** SHA-256, hex-encoded. Stable, not salted — keys are high-entropy. */
export function hashOperatorInviteToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
