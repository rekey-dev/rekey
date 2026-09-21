/**
 * Refresh tokens must be pruned, but not before replay detection is done with
 * them.
 *
 * Nothing swept these. `refresh_tokens` gains a row on every sign-in AND every
 * rotation (rotation deliberately keeps the revoked predecessor so a replay is
 * detectable), so the table grew without bound on the hottest-written path in
 * the product.
 *
 * The grace window is the load-bearing part: deleting a revoked token the
 * moment it is revoked would turn "this token was rotated", the signal that
 * triggers a family revocation, into "unknown token", silently downgrading
 * theft detection into a shrug.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { pruneExpiredSessionTokens } from '../src/lib/token-prune.js';

const DAY = 86_400_000;

async function seedApp(): Promise<{ applicationId: string; endUserId: string }> {
  const slug = Math.random().toString(36).slice(2, 10);
  const tenant = await prisma.tenant.create({
    data: { name: `T ${slug}`, ownerEmail: `owner-${slug}@example.com` },
  });
  const application = await prisma.application.create({
    data: {
      tenantId: tenant.id,
      name: `A ${slug}`,
      slug,
      publicKey: `rp_pub_${slug}`,
      authConfig: {},
      billingConfig: {},
    },
  });
  const endUser = await prisma.endUser.create({
    data: { applicationId: application.id, email: `u-${slug}@example.com`, passwordHash: 'x' },
  });
  return { applicationId: application.id, endUserId: endUser.id };
}

describe('session-token retention', () => {
  let ids: { applicationId: string; endUserId: string };
  beforeEach(async () => {
    ids = await seedApp();
  });

  it('keeps a recently revoked refresh token, so a replay is still detectable', async () => {
    const row = await prisma.refreshToken.create({
      data: {
        applicationId: ids.applicationId,
        endUserId: ids.endUserId,
        tokenHash: `h-${Math.random()}`,
        expiresAt: new Date(Date.now() - DAY),
        revokedAt: new Date(Date.now() - DAY),
      },
    });

    await pruneExpiredSessionTokens();

    expect(await prisma.refreshToken.findUnique({ where: { id: row.id } })).not.toBeNull();
  });

  it('deletes one past the forensics window', async () => {
    const old = new Date(Date.now() - 60 * DAY);
    const row = await prisma.refreshToken.create({
      data: {
        applicationId: ids.applicationId,
        endUserId: ids.endUserId,
        tokenHash: `h-${Math.random()}`,
        createdAt: old,
        expiresAt: old,
        revokedAt: old,
      },
    });

    await pruneExpiredSessionTokens();

    expect(await prisma.refreshToken.findUnique({ where: { id: row.id } })).toBeNull();
  });

  it('never touches a live token', async () => {
    const row = await prisma.refreshToken.create({
      data: {
        applicationId: ids.applicationId,
        endUserId: ids.endUserId,
        tokenHash: `h-${Math.random()}`,
        createdAt: new Date(Date.now() - 60 * DAY),
        expiresAt: new Date(Date.now() + 30 * DAY),
      },
    });

    await pruneExpiredSessionTokens();

    expect(await prisma.refreshToken.findUnique({ where: { id: row.id } })).not.toBeNull();
  });

  it('sweeps an expired reset token immediately — it has no forensic role', async () => {
    const row = await prisma.passwordResetToken.create({
      data: {
        applicationId: ids.applicationId,
        endUserId: ids.endUserId,
        tokenHash: `r-${Math.random()}`,
        expiresAt: new Date(Date.now() - DAY),
      },
    });

    await pruneExpiredSessionTokens();

    expect(await prisma.passwordResetToken.findUnique({ where: { id: row.id } })).toBeNull();
  });

  it('deletes everything eligible across several batches, and nothing else', async () => {
    const old = new Date(Date.now() - 60 * DAY);
    const base = { applicationId: ids.applicationId, endUserId: ids.endUserId };
    // 23 eligible rows at batch size 5: four full batches and a short one.
    await prisma.refreshToken.createMany({
      data: Array.from({ length: 23 }, (_, i) => ({
        ...base,
        tokenHash: `old-${i}-${Math.random()}`,
        createdAt: old,
        expiresAt: i % 2 === 0 ? old : new Date(Date.now() + DAY),
        revokedAt: i % 2 === 0 ? null : old,
      })),
    });
    const keep = await Promise.all([
      // Old but live.
      prisma.refreshToken.create({
        data: { ...base, tokenHash: `k1-${Math.random()}`, createdAt: old, expiresAt: new Date(Date.now() + DAY) },
      }),
      // Revoked, but inside the forensics window.
      prisma.refreshToken.create({
        data: { ...base, tokenHash: `k2-${Math.random()}`, expiresAt: new Date(Date.now() - DAY), revokedAt: new Date() },
      }),
    ]);
    await prisma.passwordResetToken.createMany({
      data: Array.from({ length: 7 }, (_, i) => ({
        ...base,
        tokenHash: `r-${i}-${Math.random()}`,
        expiresAt: new Date(Date.now() - DAY),
      })),
    });

    const deleted = await pruneExpiredSessionTokens({ batchSize: 5 });

    expect(deleted).toBe(30);
    const left = await prisma.refreshToken.findMany({ select: { id: true } });
    expect(left.map((r) => r.id).sort()).toEqual(keep.map((r) => r.id).sort());
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it('stops at the per-run batch cap and finishes on the next run', async () => {
    const old = new Date(Date.now() - 60 * DAY);
    await prisma.refreshToken.createMany({
      data: Array.from({ length: 12 }, (_, i) => ({
        applicationId: ids.applicationId,
        endUserId: ids.endUserId,
        tokenHash: `cap-${i}-${Math.random()}`,
        createdAt: old,
        expiresAt: old,
      })),
    });

    expect(await pruneExpiredSessionTokens({ batchSize: 5, maxBatchesPerTable: 2 })).toBe(10);
    expect(await prisma.refreshToken.count()).toBe(2);
    expect(await pruneExpiredSessionTokens({ batchSize: 5, maxBatchesPerTable: 2 })).toBe(2);
    expect(await prisma.refreshToken.count()).toBe(0);
  });

  it("never prunes a live session's head, even when the rest of its family goes", async () => {
    // An old session rotated many times: the spent predecessors are past the
    // forensics window, the head is still live. The session middleware looks
    // the head up by session_id with replaced_by_id null, and a missing head
    // ends the session, so pruning it would sign a live user out.
    const old = new Date(Date.now() - 60 * DAY);
    const base = { applicationId: ids.applicationId, endUserId: ids.endUserId };
    // Same order rotation uses: the predecessor is revoked before its
    // replacement exists, so a session never holds two live rows at once.
    const first = await prisma.refreshToken.create({
      data: { ...base, tokenHash: `f-${Math.random()}`, createdAt: old, expiresAt: old, revokedAt: old },
    });
    const sessionId = first.sessionId;
    const head = await prisma.refreshToken.create({
      data: {
        ...base,
        sessionId,
        tokenHash: `h-${Math.random()}`,
        createdAt: old,
        expiresAt: new Date(Date.now() + 30 * DAY),
      },
    });
    await prisma.refreshToken.update({
      where: { id: first.id },
      data: { replacedById: head.id },
    });

    await pruneExpiredSessionTokens({ batchSize: 1 });

    expect(await prisma.refreshToken.findUnique({ where: { id: first.id } })).toBeNull();
    const found = await prisma.refreshToken.findFirst({
      where: { sessionId, endUserId: ids.endUserId, replacedById: null },
      select: { id: true, revokedAt: true },
    });
    expect(found).toEqual({ id: head.id, revokedAt: null });
  });
});
