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
