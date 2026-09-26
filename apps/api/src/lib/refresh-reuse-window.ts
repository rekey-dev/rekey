/**
 * The refresh-token reuse window: when a replayed refresh token is a race, not
 * a theft.
 *
 * Refresh tokens are single-use, and presenting one that has already been
 * rotated revokes every session the account has, because a stolen token and
 * the victim's own copy are indistinguishable once one of them has been
 * spent. That rule also fires on clients that did nothing wrong: two tabs
 * refreshing at once through two server instances, or a client retrying after
 * the response to its first refresh was lost. Both present the same token
 * twice within moments, and both used to sign the user out of every device.
 *
 * The allowance: a rotated token presented again within
 * `REFRESH_TOKEN_REUSE_WINDOW_SECONDS` of its rotation, while its successor is
 * still the live, unused head of the session, is refused with
 * `REFRESH_TOKEN_RACED` and nothing is revoked. Nothing is issued either. The
 * replayer gets no token, so a thief replaying a stolen token inside the
 * window gains nothing it did not have (see the PR that introduced this for
 * the full threat analysis). Outside the window, or once the successor has
 * itself been rotated or revoked, the replay revokes everything exactly as
 * before.
 *
 * Kept free of Prisma so the end-user and operator refresh paths share one
 * definition of "in the window" and the rule can be tested on its own.
 */

import { env } from '../config/env.js';

export const REFRESH_REUSE_WINDOW_MS = env.REFRESH_TOKEN_REUSE_WINDOW_SECONDS * 1000;

/** The fields of a refresh row (either table) the rule reads. */
export interface ReuseWindowRow {
  id: string;
  sessionId: string;
  revokedAt: Date | null;
  replacedById: string | null;
  expiresAt: Date;
}

export type ReuseVerdict =
  | { kind: 'raced'; msSinceRotation: number }
  | { kind: 'reused'; reason: ReuseReason };

export type ReuseReason =
  /** The window is configured off. */
  | 'window_disabled'
  /** Not a rotation: the token was revoked without a successor. */
  | 'not_rotated'
  /** The rotation is older than the window. */
  | 'outside_window'
  /** The successor row is gone, or belongs to a different session. */
  | 'successor_missing'
  /** The successor has itself been rotated or revoked: the chain moved on. */
  | 'successor_spent'
  /** The successor has expired. */
  | 'successor_expired'
  // The two below are the callers' own checks on the replaying REQUEST,
  // applied after `judgeReplay` says the timing fits.
  /** Presented under another Application's key, or not a session token. */
  | 'wrong_application'
  /** A device fingerprint the successor is not bound to. */
  | 'device_mismatch';

/**
 * Decide whether a replay of the rotated `presented` token falls inside the
 * reuse window. `successor` is the row `presented.replacedById` names, as read
 * now (null when it no longer exists).
 *
 * The rotation instant is `presented.revokedAt`, which the rotation
 * transaction stamps. A negative age (another instance's clock slightly ahead
 * of ours) counts as inside the window rather than being rejected: skew
 * between instances is milliseconds, and refusing on it would bring back the
 * cascade this exists to stop.
 */
export function judgeReplay(
  presented: ReuseWindowRow,
  successor: ReuseWindowRow | null,
  now: Date,
  windowMs: number = REFRESH_REUSE_WINDOW_MS,
): ReuseVerdict {
  if (windowMs <= 0) return { kind: 'reused', reason: 'window_disabled' };
  if (presented.revokedAt === null || presented.replacedById === null) {
    return { kind: 'reused', reason: 'not_rotated' };
  }
  const msSinceRotation = now.getTime() - presented.revokedAt.getTime();
  if (msSinceRotation >= windowMs) return { kind: 'reused', reason: 'outside_window' };
  if (
    successor === null ||
    successor.id !== presented.replacedById ||
    successor.sessionId !== presented.sessionId
  ) {
    return { kind: 'reused', reason: 'successor_missing' };
  }
  // "Unused" is the load-bearing condition. Once the successor has been
  // rotated, whoever presented it holds the chain, and a replay of its
  // predecessor is no longer a sibling request racing the first use: it is
  // someone holding a token the chain has moved two steps past. A successor
  // revoked outright (sign-out, a family revocation) ends the allowance too.
  if (successor.revokedAt !== null || successor.replacedById !== null) {
    return { kind: 'reused', reason: 'successor_spent' };
  }
  if (successor.expiresAt <= now) return { kind: 'reused', reason: 'successor_expired' };
  return { kind: 'raced', msSinceRotation: Math.max(0, msSinceRotation) };
}
