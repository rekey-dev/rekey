/**
 * Periodic cleanup of expired single-use auth tokens.
 *
 * Magic-link tokens and OAuth authorization codes (both the per-Application
 * and the operator-MCP flavours) are short-lived rows that become inert the
 * moment `expiresAt` passes, the consume paths all refuse expired rows. But
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
 * rotation, rotation deliberately keeps the revoked predecessor so a replay is
 * detectable, so the table grew without bound on the hottest-written path in
 * the product, and `revokeAllForEndUser`'s updateMany scanned all of it.
 *
 * The retention window is the point. A refresh token is not disposable the
 * moment it expires or is revoked: replay detection reads the dead row to tell
 * "this token was rotated" from "this token never existed", and that answer is
 * what turns a stolen-token replay into a family revocation. Deleting on expiry
 * would silently downgrade that to "unknown token".
 *
 * So rows are kept for a grace period past the point they stop being usable,
 * long enough that any replay worth detecting has already happened, short
 * enough that the table stays bounded. Reset and verification tokens have no
 * such forensic role and only need to outlive their own expiry.
 *
 * Both auth pillars, because they have the same shape and the operator one was
 * just as unbounded.
 */
const REPLAY_FORENSICS_GRACE_DAYS = 30;

/**
 * Batched, like log-retention.ts. One unbatched DELETE against a first-run
 * backlog on refresh_tokens held row locks on the hottest table for as long as
 * it took; each statement here touches at most `batchSize` rows and commits.
 * The per-table batch cap bounds one tick; the rest waits ten minutes.
 *
 * The session head (`session_id` family, `replaced_by_id` null) is what the
 * session middleware reads to decide whether an access token's session is
 * over, and a missing head counts as ended. A live head is never eligible:
 * it is neither expired nor revoked, whatever its age.
 */
export interface SessionTokenPruneOptions {
  now?: Date;
  batchSize?: number;
  maxBatchesPerTable?: number;
}

const DEFAULT_TOKEN_BATCH = 1_000;
const DEFAULT_TOKEN_MAX_BATCHES = 50;

async function deleteInBatches(
  deleteBatch: (limit: number) => Promise<number>,
  batchSize: number,
  maxBatches: number,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const count = await deleteBatch(batchSize);
    total += count;
    if (count < batchSize) break;
  }
  return total;
}

export async function pruneExpiredSessionTokens(
  options: SessionTokenPruneOptions = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const graceCutoff = new Date(now.getTime() - REPLAY_FORENSICS_GRACE_DAYS * 86_400_000);
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_TOKEN_BATCH));
  const maxBatches = Math.max(1, Math.floor(options.maxBatchesPerTable ?? DEFAULT_TOKEN_MAX_BATCHES));

  // Expired or revoked, AND past the forensics window. The predicate is applied
  // in the subquery and again on the DELETE, so a row that changed between the
  // two (under READ COMMITTED Postgres re-checks the outer WHERE) survives.
  const refresh = await deleteInBatches(
    (limit) => prisma.$executeRaw`
      DELETE FROM "refresh_tokens"
      WHERE "id" IN (
        SELECT "id" FROM "refresh_tokens"
        WHERE "created_at" < ${graceCutoff}
          AND ("expires_at" < ${now} OR "revoked_at" IS NOT NULL)
        LIMIT ${limit}
      )
      AND "created_at" < ${graceCutoff}
      AND ("expires_at" < ${now} OR "revoked_at" IS NOT NULL)`,
    batchSize,
    maxBatches,
  );
  const tenantRefresh = await deleteInBatches(
    (limit) => prisma.$executeRaw`
      DELETE FROM "tenant_refresh_tokens"
      WHERE "id" IN (
        SELECT "id" FROM "tenant_refresh_tokens"
        WHERE "created_at" < ${graceCutoff}
          AND ("expires_at" < ${now} OR "revoked_at" IS NOT NULL)
        LIMIT ${limit}
      )
      AND "created_at" < ${graceCutoff}
      AND ("expires_at" < ${now} OR "revoked_at" IS NOT NULL)`,
    batchSize,
    maxBatches,
  );
  // No forensic role, a consumed or expired reset link is inert.
  const resets = await deleteInBatches(
    (limit) => prisma.$executeRaw`
      DELETE FROM "password_reset_tokens"
      WHERE "id" IN (
        SELECT "id" FROM "password_reset_tokens" WHERE "expires_at" < ${now} LIMIT ${limit}
      )
      AND "expires_at" < ${now}`,
    batchSize,
    maxBatches,
  );
  const verifications = await deleteInBatches(
    (limit) => prisma.$executeRaw`
      DELETE FROM "email_verification_tokens"
      WHERE "id" IN (
        SELECT "id" FROM "email_verification_tokens" WHERE "expires_at" < ${now} LIMIT ${limit}
      )
      AND "expires_at" < ${now}`,
    batchSize,
    maxBatches,
  );

  return refresh + tenantRefresh + resets + verifications;
}

/**
 * Expired generic Idempotency-Key rows (middleware/idempotency.ts, 24 h TTL).
 * Past `expiresAt` the middleware re-executes instead of replaying, so expired
 * rows are inert, this sweep just stops them accumulating. It also clears
 * orphaned in-flight reservations left by a process crash mid-request.
 */
export async function pruneExpiredIdempotencyKeys(): Promise<number> {
  const res = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return res.count;
}
