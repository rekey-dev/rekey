/**
 * Usage billed against a prepaid credit balance.
 *
 * A meter with `creditsPerUnit` charges for consumption instead of only
 * capping it. The properties that matter are the ones money demands: the
 * included quota is spent before credits, only the units past it cost
 * anything, the debit and the record commit together, a retry does not charge
 * twice, and a balance can never go negative.
 *
 * Prepaid rather than an invoice at period end because postpaid needs a stored
 * mandate, which is gated per provider — see docs/billing-architecture.md.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('Usage — prepaid credit billing', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let liveKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });
  const key = (): { authorization: string } => ({ authorization: `Bearer ${liveKey}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `up-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'UP', slug: `up-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: auth(),
        payload: { name: 'k', mode: 'live', scopes: ['billing:write'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  });

  /** A meter that charges `creditsPerUnit` per unit (null = counts only). */
  async function makeMeter(slug: string, creditsPerUnit: number | null): Promise<void> {
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/usage-meters`,
      headers: auth(),
      payload: { slug, name: slug, unit: 'calls', ...(creditsPerUnit !== null && { creditsPerUnit }) },
    });
  }

  async function makeEndUser(): Promise<string> {
    return app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: auth(),
        payload: { email: `eu-${Math.random().toString(36).slice(2, 8)}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => (r.json().data as { id: string }).id);
  }

  async function grantCredits(endUserId: string, amount: number): Promise<void> {
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users/${endUserId}/credits/grant`,
      headers: auth(),
      payload: { amount },
    });
  }

  const balanceOf = async (endUserId: string): Promise<number> =>
    (await prisma.creditBalance.findFirst({ where: { applicationId: appId, endUserId } }))?.balance ?? 0;

  /**
   * Subscribe the user to a plan that includes `included` units of the meter,
   * charging `creditsPerUnit` for anything past that. This is where a price
   * belongs: two plans may rate the same meter differently, and a meter has
   * no edit surface while its deletion cascades usage history.
   */
  async function withIncludedQuota(
    endUserId: string,
    meterSlug: string,
    included: number,
    creditsPerUnit?: number,
  ): Promise<void> {
    const slug = `q-${Math.random().toString(36).slice(2, 7)}`;
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
      payload: {
        kind: 'USAGE',
        key: meterSlug,
        quantity: included,
        ...(creditsPerUnit !== undefined && { creditsPerUnit }),
      },
    });
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug } });
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId, planId: plan.id, status: 'ACTIVE', provider: 'stripe' },
    });
  }

  const record = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/usage/record', headers: key(), payload });

  it('charges from the first unit when the plan includes none', async () => {
    // Quota 0 with a price is how an operator says "no free units". It is
    // deliberately explicit: a subject with NO usage entitlement resolves the
    // same as a subject with no plan, and billing those silently is the
    // expensive direction of that ambiguity.
    await makeMeter('calls', null);
    const eu = await makeEndUser();
    await grantCredits(eu, 100);
    await withIncludedQuota(eu, 'calls', 0, 2);

    expect((await record({ meterSlug: 'calls', quantity: 5, endUserId: eu })).statusCode).toBe(201);
    expect(await balanceOf(eu)).toBe(90); // 5 × 2
  });

  it('never charges a subject whose plan does not price the meter', async () => {
    // The whole class of legacy USAGE plans and no-plan subjects lives here.
    await makeMeter('calls', null);
    const eu = await makeEndUser();
    await grantCredits(eu, 100);

    expect((await record({ meterSlug: 'calls', quantity: 5, endUserId: eu })).statusCode).toBe(201);
    expect(await balanceOf(eu)).toBe(100);
  });

  it('spends the included quota first, and charges only the excess', async () => {
    await makeMeter('calls', null);
    const eu = await makeEndUser();
    await grantCredits(eu, 100);
    await withIncludedQuota(eu, 'calls', 10, 2);

    // Inside the quota: free.
    expect((await record({ meterSlug: 'calls', quantity: 10, endUserId: eu })).statusCode).toBe(201);
    expect(await balanceOf(eu)).toBe(100);

    // Straddling: 0 left included, so all 4 are charged.
    expect((await record({ meterSlug: 'calls', quantity: 4, endUserId: eu })).statusCode).toBe(201);
    expect(await balanceOf(eu)).toBe(92);
  });

  it('splits a record that straddles the quota boundary', async () => {
    await makeMeter('calls', null);
    const eu = await makeEndUser();
    await grantCredits(eu, 100);
    await withIncludedQuota(eu, 'calls', 10, 3);

    // 8 used, 2 included left, 6 units charged out of a record of 8.
    await record({ meterSlug: 'calls', quantity: 8, endUserId: eu });
    expect(await balanceOf(eu)).toBe(100);
    expect((await record({ meterSlug: 'calls', quantity: 8, endUserId: eu })).statusCode).toBe(201);
    expect(await balanceOf(eu)).toBe(100 - 6 * 3);
  });

  it('refuses and records nothing when the balance is too low', async () => {
    await makeMeter('calls', null);
    const eu = await makeEndUser();
    await grantCredits(eu, 15);
    await withIncludedQuota(eu, 'calls', 0, 10);

    const res = await record({ meterSlug: 'calls', quantity: 2, endUserId: eu });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('CREDITS_INSUFFICIENT');

    // The whole point of the shared transaction: no unpaid usage survives.
    const count = await prisma.usageRecord.count({ where: { endUserId: eu } });
    expect(count).toBe(0);
    expect(await balanceOf(eu)).toBe(15);
  });

  it('does not charge twice for a retried record', async () => {
    await makeMeter('calls', null);
    const eu = await makeEndUser();
    await grantCredits(eu, 100);
    await withIncludedQuota(eu, 'calls', 0, 5);

    const payload = { meterSlug: 'calls', quantity: 3, endUserId: eu, idempotencyKey: 'job-1' };
    expect((await record(payload)).statusCode).toBe(201);
    expect((await record(payload)).statusCode).toBe(201);

    expect(await balanceOf(eu)).toBe(85); // charged once
    expect(await prisma.usageRecord.count({ where: { endUserId: eu } })).toBe(1);
  });

  it('leaves an unpriced meter capping rather than charging', async () => {
    await makeMeter('calls', null);
    const eu = await makeEndUser();
    await grantCredits(eu, 100);
    await withIncludedQuota(eu, 'calls', 2);

    expect((await record({ meterSlug: 'calls', quantity: 2, endUserId: eu })).statusCode).toBe(201);
    const over = await record({ meterSlug: 'calls', quantity: 1, endUserId: eu });
    expect(over.statusCode).toBe(402);
    expect(over.json().error.code).toBe('USAGE_QUOTA_EXCEEDED');
    expect(await balanceOf(eu)).toBe(100); // never touched
  });

  it('keeps what a record cost, so a price change does not restate history', async () => {
    await makeMeter('calls', null);
    const eu = await makeEndUser();
    await grantCredits(eu, 100);
    await withIncludedQuota(eu, 'calls', 0, 4);
    await record({ meterSlug: 'calls', quantity: 2, endUserId: eu });

    const before = await prisma.usageRecord.findFirstOrThrow({ where: { endUserId: eu } });
    expect(before.creditsCharged).toBe(8);

    // Re-price by writing the entitlement again — the same route an operator's
    // panel edit goes through.
    const plan = await prisma.plan.findFirstOrThrow({
      where: { applicationId: appId, entitlements: { some: { key: 'calls' } } },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans/${plan.slug}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 0, creditsPerUnit: 40 },
    });

    const after = await prisma.usageRecord.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.creditsCharged).toBe(8);
  });

  it('charges from the meter price when the plan does not price the meter', async () => {
    // The documented fallback, and the case every other test here misses
    // because they all create an unpriced meter.
    await makeMeter('calls', 2);
    const eu = await makeEndUser();
    await grantCredits(eu, 100);
    await withIncludedQuota(eu, 'calls', 5);

    expect((await record({ meterSlug: 'calls', quantity: 8, endUserId: eu })).statusCode).toBe(201);
    expect(await balanceOf(eu)).toBe(94); // 3 past the quota × 2
  });

  it('meters without charging when the rate is zero', async () => {
    // Zero is admitted by the route, the validator and the panel. It must mean
    // "free", not "every record 400s" — `consume` rejects a non-positive
    // amount, so the debit has to be skipped rather than attempted.
    await makeMeter('calls', null);
    const eu = await makeEndUser();
    await grantCredits(eu, 50);
    await withIncludedQuota(eu, 'calls', 0, 0);

    const res = await record({ meterSlug: 'calls', quantity: 5, endUserId: eu });
    expect(res.statusCode).toBe(201);
    expect(await balanceOf(eu)).toBe(50);
    const row = await prisma.usageRecord.findFirstOrThrow({ where: { endUserId: eu } });
    expect(row.creditsCharged).toBe(0);
  });

  it('refuses a record whose idempotency key was already spent on the ledger', async () => {
    // The key is namespaced per meter, but a caller of POST /credits/consume
    // holds the same billing:write scope and can spend it first. Without this
    // the record was written stamped with a charge that never happened.
    await makeMeter('calls', null);
    const eu = await makeEndUser();
    await grantCredits(eu, 100);
    await withIncludedQuota(eu, 'calls', 0, 5);

    const meter = await prisma.usageMeter.findFirstOrThrow({ where: { applicationId: appId, slug: 'calls' } });
    await app.inject({
      method: 'POST',
      url: '/api/v1/credits/consume',
      headers: key(),
      // The ledger key carries the subject now, so a collision has to name it.
      payload: { endUserId: eu, amount: 1, idempotencyKey: `usage:${meter.id}:u:${eu}:job-9` },
    });

    const res = await record({ meterSlug: 'calls', quantity: 10, endUserId: eu, idempotencyKey: 'job-9' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('USAGE_IDEMPOTENCY_KEY_REUSED');
    expect(await prisma.usageRecord.count({ where: { endUserId: eu } })).toBe(0);
  });

  it('keeps the ledger and the records agreeing to the credit', async () => {
    // The invariant that catches a whole class of bug at once: every credit a
    // record says it cost must appear as a debit, and vice versa.
    await makeMeter('calls', null);
    const eu = await makeEndUser();
    await grantCredits(eu, 500);
    await withIncludedQuota(eu, 'calls', 10, 3);

    for (const q of [4, 9, 2, 7]) {
      await record({ meterSlug: 'calls', quantity: q, endUserId: eu, idempotencyKey: `k-${q}` });
      await record({ meterSlug: 'calls', quantity: q, endUserId: eu, idempotencyKey: `k-${q}` }); // retry
    }

    const charged = await prisma.usageRecord.aggregate({
      _sum: { creditsCharged: true },
      where: { endUserId: eu },
    });
    const spent = await prisma.creditLedger.aggregate({
      _sum: { delta: true },
      where: { endUserId: eu, reason: 'CONSUME' },
    });
    expect(charged._sum.creditsCharged ?? 0).toBe(-(spent._sum.delta ?? 0));
  });

  it('does not let one subject\'s idempotency key return another\'s record', async () => {
    // The key was scoped (meter, key) with no subject, so B reusing A's key —
    // by accident or otherwise — got back A's record: B's usage unrecorded and
    // uncharged, one record standing for two subjects' consumption.
    await makeMeter('calls', null);
    const a = await makeEndUser();
    const b = await makeEndUser();
    await grantCredits(a, 100);
    await grantCredits(b, 100);
    await withIncludedQuota(a, 'calls', 0, 5);
    await withIncludedQuota(b, 'calls', 0, 5);

    expect((await record({ meterSlug: 'calls', quantity: 4, endUserId: a, idempotencyKey: 'shared' })).statusCode).toBe(201);
    expect((await record({ meterSlug: 'calls', quantity: 4, endUserId: b, idempotencyKey: 'shared' })).statusCode).toBe(201);

    // Both charged, both recorded.
    expect(await balanceOf(a)).toBe(80);
    expect(await balanceOf(b)).toBe(80);
    expect(await prisma.usageRecord.count({ where: { endUserId: a } })).toBe(1);
    expect(await prisma.usageRecord.count({ where: { endUserId: b } })).toBe(1);
  });

  it('still deduplicates a retry by the same subject', async () => {
    await makeMeter('calls', null);
    const eu = await makeEndUser();
    await grantCredits(eu, 100);
    await withIncludedQuota(eu, 'calls', 0, 5);

    const payload = { meterSlug: 'calls', quantity: 4, endUserId: eu, idempotencyKey: 'same' };
    await record(payload);
    await record(payload);

    expect(await balanceOf(eu)).toBe(80);
    expect(await prisma.usageRecord.count({ where: { endUserId: eu } })).toBe(1);
  });
});
