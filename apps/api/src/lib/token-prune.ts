/**
 * Periodic cleanup of expired single-use auth tokens.
 *
 * Magic-link tokens and OAuth authorization codes (both the per-Application
 * and the operator-MCP flavours) are short-lived rows that become inert the
 * moment `expiresAt` passes — the consume paths all refuse expired rows. But
 * nothing deleted them, so abandoned requests accumulated forever (every
 * magic-link email, every started-but-not-finished OAuth flow). This sweep
 * deletes anything past expiry; scheduled from app.ts alongside the other
 * interval jobs (request-log prune, webhook retry poller).
 *
 * Best-effort: a missed run just means the rows wait for the next sweep.
 */

import { prisma } from './prisma.js';

export async function pruneExpiredAuthTokens(): Promise<number> {
  const now = new Date();
  const [magicLinks, authCodes, tenantAuthCodes] = await Promise.all([
    prisma.magicLinkToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.oAuthAuthCode.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.tenantOAuthAuthCode.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  return magicLinks.count + authCodes.count + tenantAuthCodes.count;
}

/**
 * Long-lived auth tokens whose window has fully closed.
 *
 * Nothing pruned these. `refresh_tokens` gains a row on every sign-in AND every
 * rotation — rotation deliberately keeps the revoked predecessor so a replay is
 * detectable — so the table grew without bound on the hottest-written path in
 * the product, and `revokeAllForEndUser`'s updateMany scanned all of it.
 *
 * The retention window is the point. A refresh token is not disposable the
 * moment it expires or is revoked: replay detection reads the dead row to tell
 * "this token was rotated" from "this token never existed", and that answer is
 * what turns a stolen-token replay into a family revocation. Deleting on expiry
 * would silently downgrade that to "unknown token".
 *
 * So rows are kept for a grace period past the point they stop being usable —
 * long enough that any replay worth detecting has already happened, short
 * enough that the table stays bounded. Reset and verification tokens have no
 * such forensic role and only need to outlive their own expiry.
 *
 * Both auth pillars, because they have the same shape and the operator one was
 * just as unbounded.
 */
const REPLAY_FORENSICS_GRACE_DAYS = 30;

export async function pruneExpiredSessionTokens(): Promise<number> {
  const now = new Date();
  const graceCutoff = new Date(now.getTime() - REPLAY_FORENSICS_GRACE_DAYS * 86_400_000);

  const [refresh, tenantRefresh, resets, verifications] = await Promise.all([
    // Expired or revoked, AND past the forensics window.
    prisma.refreshToken.deleteMany({
      where: {
        createdAt: { lt: graceCutoff },
        OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }],
      },
    }),
    prisma.tenantRefreshToken.deleteMany({
      where: {
        createdAt: { lt: graceCutoff },
        OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }],
      },
    }),
    // No forensic role — a consumed or expired reset link is inert.
    prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);

  return refresh.count + tenantRefresh.count + resets.count + verifications.count;
}

/**
 * Expired generic Idempotency-Key rows (middleware/idempotency.ts, 24 h TTL).
 * Past `expiresAt` the middleware re-executes instead of replaying, so expired
 * rows are inert — this sweep just stops them accumulating. It also clears
 * orphaned in-flight reservations left by a process crash mid-request.
 */
export async function pruneExpiredIdempotencyKeys(): Promise<number> {
  const res = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return res.count;
}
