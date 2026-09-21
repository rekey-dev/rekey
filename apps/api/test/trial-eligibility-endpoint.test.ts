/**
 * `GET /api/v1/billing/trial-eligibility` (#477).
 *
 * The read half of the trial feature. Without it a pricing page renders
 * "Start 14 days free" from the plan alone and the buyer discovers at checkout,
 * via a 409, that they are not eligible. The refusal is honest; the button is a
 * better place to learn it.
 *
 * ADVISORY by design, the authoritative decision is taken under a lock in
 * `createCheckoutSession`, so two tabs can both read `eligible: true`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';

const PASSWORD = 'pw-one-two-three';

interface Item {
  planSlug: string;
  trialDays: number | null;
  eligible: boolean;
  reason: string | null;
  redeemedAt: string | null;
  endsAt: string | null;
}

describe('GET /billing/trial-eligibility', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;
  let userAccess: string;
  let endUserId: string;
  let operatorAccess: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const slug = `te-${Math.random().toString(36).slice(2, 8)}`;
    operatorAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await configureSandboxStripe(applicationId);

    for (const p of [
      { slug: 'pro', name: 'Pro', amount: 9900, kind: 'SUBSCRIPTION', trialDays: 14 },
      { slug: 'team', name: 'Team', amount: 4900, kind: 'SUBSCRIPTION', trialDays: 14 },
      { slug: 'basic', name: 'Basic', amount: 900, kind: 'SUBSCRIPTION' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/plans`,
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: p,
      });
      expect(res.statusCode).toBe(201);
    }

    const signUp = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${slug}@example.com`, password: PASSWORD },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
    userAccess = signUp.accessToken;
    endUserId = signUp.endUser.id;
  });

  async function read(qs = ''): Promise<{ statusCode: number; items: Item[]; policy: string; provider: string }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/billing/trial-eligibility${qs}`,
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
    });
    const data = res.statusCode === 200 ? (res.json().data as { items: Item[]; policy: string; provider: string }) : null;
    return {
      statusCode: res.statusCode,
      items: data?.items ?? [],
      policy: data?.policy ?? '',
      provider: data?.provider ?? '',
    };
  }

  const bySlug = (items: Item[], slug: string): Item => items.find((i) => i.planSlug === slug)!;

  it('a fresh buyer is eligible for every plan that offers a trial', async () => {
    const { statusCode, items, policy, provider } = await read();
    expect(statusCode).toBe(200);
    expect(policy).toBe('once_per_application');
    // Echoed because the answer is provider-dependent: a provider picker should
    // re-read this when the buyer changes processor.
    expect(provider).toBe('stripe');

    expect(bySlug(items, 'pro')).toMatchObject({ trialDays: 14, eligible: true, reason: null });
    expect(bySlug(items, 'team')).toMatchObject({ trialDays: 14, eligible: true, reason: null });
    // A plan with no trial is not "ineligible", it simply has none to offer.
    expect(bySlug(items, 'basic')).toMatchObject({
      trialDays: null,
      eligible: false,
      reason: 'PLAN_HAS_NO_TRIAL',
    });
  });

  it('a consumed trial makes every OTHER plan ALREADY_REDEEMED under once_per_application', async () => {
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId, slug: 'team' } });
    await prisma.trialRedemption.create({
      data: {
        applicationId,
        subjectKey: `user:${endUserId}`,
        endUserId,
        planId: plan.id,
        status: 'CONSUMED',
        trialDays: 14,
        startedAt: new Date(Date.now() - 40 * 86_400_000),
        endsAt: new Date(Date.now() - 26 * 86_400_000),
      },
    });

    const { items } = await read();
    const pro = bySlug(items, 'pro');
    expect(pro.eligible).toBe(false);
    expect(pro.reason).toBe('ALREADY_REDEEMED');
    expect(pro.redeemedAt).not.toBeNull();
    // NOT "your trial ends on the 3rd", that is false copy on a plan they were
    // never on. TRIAL_IN_PROGRESS is scoped to the plan; this is not it.
    expect(pro.endsAt).toBeNull();
  });

  it('a running trial reports TRIAL_IN_PROGRESS, but only on its own plan', async () => {
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId, slug: 'team' } });
    const endsAt = new Date(Date.now() + 5 * 86_400_000);
    await prisma.trialRedemption.create({
      data: {
        applicationId,
        subjectKey: `user:${endUserId}`,
        endUserId,
        planId: plan.id,
        status: 'CONSUMED',
        trialDays: 14,
        startedAt: new Date(Date.now() - 9 * 86_400_000),
        endsAt,
      },
    });

    const { items } = await read();
    const team = bySlug(items, 'team');
    expect(team.reason).toBe('TRIAL_IN_PROGRESS');
    expect(team.endsAt).toBe(endsAt.toISOString());
    // The same slot blocks `pro`, but the copy for it is different.
    expect(bySlug(items, 'pro').reason).toBe('ALREADY_REDEEMED');
  });

  it("a buyer's OWN live reservation still reads eligible", async () => {
    // The inversion this exists to prevent: a buyer opens a trial checkout,
    // bails at the provider and comes back. Reporting their own RESERVED row as
    // a refusal makes the SDK send `allowWithoutTrial` and charges them today
    // for the trial checkout was about to grant.
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId, slug: 'pro' } });
    await prisma.trialRedemption.create({
      data: {
        applicationId,
        subjectKey: `user:${endUserId}`,
        endUserId,
        planId: plan.id,
        status: 'RESERVED',
        trialDays: 14,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const { items } = await read();
    expect(bySlug(items, 'pro')).toMatchObject({ eligible: true, reason: null });
  });

  it('once_per_plan blocks only the plan that was trialled', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/billing-config`,
      headers: { authorization: `Bearer ${operatorAccess}` },
      payload: { trialPolicy: 'once_per_plan' },
    });
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId, slug: 'team' } });
    await prisma.trialRedemption.create({
      data: {
        applicationId,
        subjectKey: `user:${endUserId}`,
        endUserId,
        planId: plan.id,
        status: 'CONSUMED',
        trialDays: 14,
        startedAt: new Date(Date.now() - 40 * 86_400_000),
        endsAt: new Date(Date.now() - 26 * 86_400_000),
      },
    });

    const { items, policy } = await read();
    expect(policy).toBe('once_per_plan');
    expect(bySlug(items, 'team').reason).toBe('ALREADY_REDEEMED');
    expect(bySlug(items, 'pro').eligible).toBe(true);
  });

  it('planSlug narrows to one plan', async () => {
    const { items } = await read('?planSlug=pro');
    expect(items).toHaveLength(1);
    expect(items[0]!.planSlug).toBe('pro');
  });

  it('requires a user session — a per-buyer answer with no buyer is a lie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/trial-eligibility',
      headers: { authorization: `Bearer ${liveKey}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
