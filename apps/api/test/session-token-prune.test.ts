/**
 * Refresh tokens must be pruned — but not before replay detection is done with
 * them.
 *
 * Nothing swept these. `refresh_tokens` gains a row on every sign-in AND every
 * rotation (rotation deliberately keeps the revoked predecessor so a replay is
 * detectable), so the table grew without bound on the hottest-written path in
 * the product.
 *
 * The grace window is the load-bearing part: deleting a revoked token the
 * moment it is revoked would turn "this token was rotated" — the signal that
 * triggers a family revocation — into "unknown token", silently downgrading
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
});
