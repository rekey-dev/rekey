/**
 * Lock granularity of capped usage records (#418).
 *
 * The cap is per subject, so records serialise per (meter, subject): racers on
 * one subject must never overshoot its quota, and a record for one subject must
 * not wait behind another subject of the same meter. Each "lock held" case holds
 * the exact advisory key `record` takes, from a separate transaction, and
 * watches `pg_locks` for the waiter rather than trusting timing alone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { RekeyError } from '../src/lib/error.js';
import { usageService } from '../src/modules/usage/usage.service.js';

describe('Usage record: per-subject quota lock', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let meterId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `ul-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'UL', slug: `ul-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/usage-meters`,
      headers: auth(),
      payload: { slug: 'api_calls', name: 'API calls', unit: 'calls' },
    });
    meterId = (await prisma.usageMeter.findFirstOrThrow({ where: { applicationId: appId, slug: 'api_calls' } })).id;
  });

  async function makeEndUser(): Promise<string> {
    return app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: auth(),
        payload: { email: `eu-${Math.random().toString(36).slice(2, 9)}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => (r.json().data as { id: string }).id);
  }

  async function makeCappedPlan(slug: string, included: number): Promise<string> {
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug, name: slug, amount: 0, kind: 'SUBSCRIPTION' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'api_calls', quantity: included },
    });
    return (await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug } })).id;
  }

  async function cappedEndUser(planId: string): Promise<string> {
    const euId = await makeEndUser();
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId: euId, planId, status: 'ACTIVE', provider: 'stripe' },
    });
    return euId;
  }

  const record = (subject: { endUserId?: string; organizationId?: string }) =>
    usageService.record({ applicationId: appId, meterSlug: 'api_calls', quantity: 1, ...subject });

  /**
   * Hold `key` in its own transaction until the returned `release` is called.
   * Resolves once the lock is actually granted.
   */
  async function holdAdvisoryLock(key: string): Promise<{ release: () => Promise<void> }> {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let granted!: () => void;
    const isGranted = new Promise<void>((r) => (granted = r));
    const done = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        granted();
        await released;
      },
      { timeout: 30_000 },
    );
    await isGranted;
    return {
      release: async () => {
        release();
        await done;
      },
    };
  }

  async function waitForAdvisoryWaiter(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
      if (row && row.n > 0n) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no record ever waited on the advisory lock');
  }

  /** Settles with 'pending' if `p` has not settled within `ms`. */
  function settledWithin<T>(p: Promise<T>, ms: number): Promise<'pending' | 'fulfilled' | 'rejected'> {
    return Promise.race([
      p.then(
        () => 'fulfilled' as const,
        () => 'rejected' as const,
      ),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms)),
    ]);
  }

  it('16 racers on one subject at the cap boundary never exceed the quota', async () => {
    const planId = await makeCappedPlan('capped', 5);
    const euId = await cappedEndUser(planId);
    // Two already used, so the boundary sits at 3 more.
    await record({ endUserId: euId });
    await record({ endUserId: euId });

    const results = await Promise.allSettled(Array.from({ length: 16 }, () => record({ endUserId: euId })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter(
      (r) => r.status === 'rejected' && (r.reason as RekeyError).code === 'USAGE_QUOTA_EXCEEDED',
    ).length;
    expect({ ok, refused }).toEqual({ ok: 3, refused: 13 });

    const agg = await prisma.usageRecord.aggregate({ _sum: { quantity: true }, where: { meterId, endUserId: euId } });
    expect(agg._sum.quantity).toBe(5);
  });

  it('a record for one subject does not wait behind another subject of the same meter', async () => {
    const planId = await makeCappedPlan('capped', 100);
    const blocked = await cappedEndUser(planId);
    const free = await cappedEndUser(planId);

    const holder = await holdAdvisoryLock(`rekey:usage:${meterId}:u:${blocked}`);
    // The same subject queues behind the held lock...
    const blockedRecord = record({ endUserId: blocked });
    await waitForAdvisoryWaiter();
    // ...while a different subject of the same meter goes straight through,
    // even though a record of this meter is mid-transaction.
    const freeRecords = Promise.all(Array.from({ length: 8 }, () => record({ endUserId: free })));
    expect(await settledWithin(freeRecords, 1_500)).toBe('fulfilled');
    expect(await settledWithin(blockedRecord, 50)).toBe('pending');

    await holder.release();
    await expect(blockedRecord).resolves.toMatchObject({ endUserId: blocked, quantity: 1 });
  });

  it('a record carrying both ids also waits on the end-user it lands in', async () => {
    // Not reachable from the public route, which refuses both ids, but the
    // quota sums are by id column, so such a row counts toward the end-user.
    const orgPlan = await makeCappedPlan('team', 100);
    const owner = await makeEndUser();
    const orgId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/organizations`,
        headers: auth(),
        payload: { name: 'Acme', slug: 'acme', ownerEndUserId: owner },
      })
      .then((r) => (r.json().data as { id: string }).id);
    await prisma.subscription.create({
      data: {
        applicationId: appId,
        endUserId: owner,
        planId: orgPlan,
        beneficiaryOrgId: orgId,
        status: 'ACTIVE',
        provider: 'stripe',
      },
    });

    const holder = await holdAdvisoryLock(`rekey:usage:${meterId}:u:${owner}`);
    const both = record({ organizationId: orgId, endUserId: owner });
    await waitForAdvisoryWaiter();
    expect(await settledWithin(both, 200)).toBe('pending');
    await holder.release();
    await expect(both).resolves.toMatchObject({ organizationId: orgId, endUserId: owner });
  });

  it('gives up with a retryable 503 instead of holding a connection to the transaction timeout', async () => {
    const planId = await makeCappedPlan('capped', 100);
    const euId = await cappedEndUser(planId);

    const holder = await holdAdvisoryLock(`rekey:usage:${meterId}:u:${euId}`);
    const started = Date.now();
    const err = await record({ endUserId: euId }).then(
      () => null,
      (e: unknown) => e,
    );
    const waited = Date.now() - started;
    await holder.release();

    expect(err).toBeInstanceOf(RekeyError);
    expect(err).toMatchObject({ statusCode: 503, code: 'USAGE_RECORD_BUSY' });
    expect(waited).toBeGreaterThanOrEqual(1_900);
    expect(waited).toBeLessThan(4_500);
    expect(await prisma.usageRecord.count({ where: { meterId } })).toBe(0);
  });
});
