/**
 * The last-sign-in backfill (a batched script run after the deploy, not a
 * migration statement) and the index that serves the list's
 * `sort=lastSignedInAt&order=desc`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { backfillLastSignIn } from '../src/scripts/backfill-last-sign-in.js';

describe('last sign-in backfill', () => {
  let appId: string;

  beforeEach(async () => {
    const app = await prisma.application.create({
      data: {
        name: 'BF',
        slug: `bf-${Math.random().toString(36).slice(2, 8)}`,
        publicKey: `rp_pub_bf_${Math.random().toString(36).slice(2, 10)}`,
        authConfig: {},
        billingConfig: {},
        tenant: { create: { name: 'BF', ownerEmail: 'bf@example.com' } },
      },
    });
    appId = app.id;
  });

  async function user(email: string) {
    return prisma.endUser.create({ data: { applicationId: appId, email } });
  }

  async function signedIn(endUserId: string, via: string, daysAgo: number): Promise<void> {
    await prisma.securityEvent.create({
      data: {
        applicationId: appId,
        actorType: 'end_user',
        subjectEndUserId: endUserId,
        type: 'user.signed_in',
        metadata: { via },
        createdAt: new Date(Date.now() - daysAgo * 86_400_000),
      },
    });
  }

  it('fills the newest stored sign-in in small batches, and a second run changes nothing', async () => {
    const users = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((n) => user(`${n}@example.com`)));
    await signedIn(users[0]!.id, 'password', 3);
    await signedIn(users[0]!.id, 'passkey', 1);
    await signedIn(users[2]!.id, 'magic_link', 5);
    await signedIn(users[4]!.id, 'oauth', 2);
    await prisma.securityEvent.create({
      data: { applicationId: appId, actorType: 'end_user', subjectEndUserId: users[1]!.id, type: 'user.signed_up' },
    });

    const first = await backfillLastSignIn({ batchSize: 2 });
    expect(first).toMatchObject({ updated: 3, batches: 3 });
    const rows = await prisma.endUser.findMany({ where: { applicationId: appId }, orderBy: { email: 'asc' } });
    expect(rows.map((r) => r.lastSignInVia)).toEqual(['passkey', null, 'magic_link', null, 'oauth']);
    expect(rows[1]!.lastSignedInAt).toBeNull();

    expect((await backfillLastSignIn({ batchSize: 2 })).updated).toBe(0);
  });

  it('never overwrites a sign-in recorded since the deploy', async () => {
    const u = await user('live@example.com');
    const recent = new Date();
    await prisma.endUser.update({ where: { id: u.id }, data: { lastSignedInAt: recent, lastSignInVia: 'mfa' } });
    await signedIn(u.id, 'password', 10);
    await backfillLastSignIn({ batchSize: 10 });
    const after = await prisma.endUser.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.lastSignInVia).toBe('mfa');
    expect(after.lastSignedInAt!.getTime()).toBe(recent.getTime());
  });
});

describe('list index', () => {
  it('serves ORDER BY last_signed_in_at DESC NULLS LAST, id DESC without a sort', async () => {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
      // With sorting priced out too, only an index already in this order can
      // answer without a Sort node. Without it the planner's pick depends on
      // whatever earlier test files left in the table.
      await tx.$executeRawUnsafe('SET LOCAL enable_sort = off');
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN SELECT id FROM end_users WHERE application_id = 'x'
          ORDER BY last_signed_in_at DESC NULLS LAST, id DESC LIMIT 25`,
      );
    });
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toContain('end_users_application_id_last_signed_in_at_desc_id_idx');
    expect(text).not.toMatch(/\bSort\b/);
    const [index] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'end_users_application_id_last_signed_in_at_desc_id_idx'`;
    expect(index?.indexdef).toContain('last_signed_in_at DESC NULLS LAST, id DESC');
  });
});
