/**
 * One trial per buyer (#477).
 *
 * Before this, `resolveCheckoutTrial` was a pure function of the plan and
 * nothing anywhere asked whether the buyer had trialled before: trial, cancel
 * on day 13, click Buy, repeat, without limit, and on a plan carrying
 * entitlements each loop handed out a full period of credits.
 *
 * These exercise the eligibility service directly. That is where the decision
 * lives, and it keeps each rule pinned by a test that fails for exactly one
 * reason rather than through a full provider round-trip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import {
  checkTrialEligibility,
  consumeTrial,
  releaseTrial,
  reserveTrial,
  slotHolderWhere,
  trialSubjectKey,
} from '../src/modules/billing/trial-eligibility.service.js';

describe('trial eligibility', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let basicId: string;
  let proId: string;
  let euId: string;
  let subjectKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `tr-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: `App ${slug}`, slug: `app-${slug}` },
      })
      .then((r) => (r.json().data as { id: string }).id);

    for (const s of ['basic', 'pro']) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/plans`,
        headers: auth(),
        payload: { slug: s, name: s, amount: 900, kind: 'SUBSCRIPTION' },
      });
    }
    basicId = (await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'basic' } })).id;
    proId = (await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'pro' } })).id;

    euId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: auth(),
        payload: { email: `buyer-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => (r.json().data as { id: string }).id);
    subjectKey = trialSubjectKey({ billingSubject: 'user', endUserId: euId });
  });

  const hourAway = (): Date => new Date(Date.now() + 3_600_000);

  async function reserve(planId: string, expiresAt: Date = hourAway()) {
    return reserveTrial(prisma, {
      applicationId: appId,
      subjectKey,
      endUserId: euId,
      planId,
      trialDays: 14,
      expiresAt,
    });
  }

  const check = (planId: string, policy: 'once_per_application' | 'once_per_plan' | 'unlimited') =>
    checkTrialEligibility(prisma, { applicationId: appId, subjectKey, planId, policy });

  // ---------------------------------------------------------------- policies

  it('once_per_application: a trial on ANY plan spends the one slot', async () => {
    expect((await check(proId, 'once_per_application')).eligible).toBe(true);

    const r = await reserve(basicId);
    await prisma.trialRedemption.update({ where: { id: r.id }, data: { checkoutSessionId: 'cs_1' } });
    await consumeTrial({ applicationId: appId, checkoutSessionId: 'cs_1', subscriptionId: null });

    // THE rule: trialling `basic` then `pro` is two free months of the product.
    const after = await check(proId, 'once_per_application');
    expect(after.eligible).toBe(false);
    expect(after.blockedBy?.planId).toBe(basicId);
  });

  it('once_per_plan: a different plan is still eligible, the same plan is not', async () => {
    const r = await reserve(basicId);
    await prisma.trialRedemption.update({ where: { id: r.id }, data: { checkoutSessionId: 'cs_2' } });
    await consumeTrial({ applicationId: appId, checkoutSessionId: 'cs_2', subscriptionId: null });

    expect((await check(proId, 'once_per_plan')).eligible).toBe(true);
    expect((await check(basicId, 'once_per_plan')).eligible).toBe(false);
  });

  it('unlimited: never refuses, and reads nothing', async () => {
    const r = await reserve(basicId);
    await prisma.trialRedemption.update({ where: { id: r.id }, data: { checkoutSessionId: 'cs_3' } });
    await consumeTrial({ applicationId: appId, checkoutSessionId: 'cs_3', subscriptionId: null });
    expect((await check(basicId, 'unlimited')).eligible).toBe(true);
  });

  // ------------------------------------------------------------ slot holding

  it('an expired RESERVED row stops holding the slot; a live one holds it', async () => {
    await reserve(basicId, new Date(Date.now() - 1000));
    expect((await check(proId, 'once_per_application')).eligible).toBe(true);

    await reserve(basicId, hourAway());
    expect((await check(proId, 'once_per_application')).eligible).toBe(false);
  });

  it('a RESERVED row with a NULL expiry holds the slot indefinitely', async () => {
    // The fail-CLOSED case: a confirmation that could not be recorded clears
    // `expiresAt`. Ageing it out would hand the buyer another trial, which is
    // failing open for an anti-abuse control.
    const r = await reserve(basicId);
    await prisma.trialRedemption.update({ where: { id: r.id }, data: { expiresAt: null } });
    expect((await check(proId, 'once_per_application')).eligible).toBe(false);
  });

  it('a RELEASED row never holds the slot', async () => {
    const r = await reserve(basicId);
    await releaseTrial(prisma, r.id);
    expect((await check(proId, 'once_per_application')).eligible).toBe(true);
  });

  // ------------------------------------------------------- takeover, not block

  it('a second checkout takes the reservation over rather than being blocked', async () => {
    const first = await reserve(basicId);
    const second = await reserve(proId);

    // Blocking instead would tell a buyer who bailed at the provider and came
    // straight back that they must wait out the session lifetime.
    expect(second.id).not.toBe(first.id);
    expect((await prisma.trialRedemption.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('RELEASED');

    // Still exactly ONE slot held.
    const holders = await prisma.trialRedemption.count({
      where: slotHolderWhere(appId, subjectKey, new Date()),
    });
    expect(holders).toBe(1);
  });

  it('a RELEASED reservation whose session is paid anyway still records CONSUMED', async () => {
    const first = await reserve(basicId);
    await prisma.trialRedemption.update({ where: { id: first.id }, data: { checkoutSessionId: 'cs_old' } });
    await reserve(proId); // takes over; `first` goes RELEASED
    expect((await prisma.trialRedemption.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('RELEASED');

    // The buyer went back and paid the older tab. That trial really did start
    // at the provider, so the truthful record is CONSUMED, not a lost row.
    const out = await consumeTrial({
      applicationId: appId,
      checkoutSessionId: 'cs_old',
      subscriptionId: null,
    });
    expect(out.recorded).toBe(true);
    const row = await prisma.trialRedemption.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.status).toBe('CONSUMED');
    expect(row.expiresAt).toBeNull();
    expect(row.startedAt).not.toBeNull();
    // endsAt comes from the days actually sent to the provider, not the plan,
    // because the plan's value changes underneath.
    expect(row.endsAt).not.toBeNull();
    expect(Math.round((row.endsAt!.getTime() - row.startedAt!.getTime()) / 86_400_000)).toBe(14);
  });

  it('confirming a session that carried no trial is a no-op, not an error', async () => {
    const out = await consumeTrial({
      applicationId: appId,
      checkoutSessionId: 'cs_never_existed',
      subscriptionId: null,
    });
    expect(out.recorded).toBe(false);
  });

  // ------------------------------------------------------------- the subject

  it('an org-billed application counts the trial against the ORG, not the member', async () => {
    // Keying on the individual would hand a five-person team five trials, and
    // would refuse a colleague who takes the account over.
    const orgKey = trialSubjectKey({
      billingSubject: 'org',
      endUserId: euId,
      beneficiaryOrgId: 'org_abc',
    });
    expect(orgKey).toBe('org:org_abc');
    expect(trialSubjectKey({ billingSubject: 'user', endUserId: euId, beneficiaryOrgId: 'org_abc' })).toBe(
      `user:${euId}`,
    );
    // An org-billed app with no beneficiary falls back to the user rather than
    // producing `org:null` and colliding every such buyer into one slot.
    expect(trialSubjectKey({ billingSubject: 'org', endUserId: euId, beneficiaryOrgId: null })).toBe(
      `user:${euId}`,
    );
  });
});
