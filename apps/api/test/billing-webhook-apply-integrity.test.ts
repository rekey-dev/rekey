/**
 * Money-path findings from the live e2e run of the billing webhook appliers.
 *
 *  1. The same buyer activating one plan for two organizations rebound the
 *     first organization's row to the second subscription id, so the second
 *     organization got nothing and cancelling the first id was then ignored.
 *     The operator grant answered 200 "already entitled" with the first
 *     organization's row.
 *  2. An activation delivered after the cancellation it predates reopened the
 *     cancelled row, and a restated period end a few seconds later minted a
 *     second period's credits.
 *  3. `payment.refunded` marked the whole payment REFUNDED whatever the amount,
 *     and revenue dropped the full charge. Stripe refunds were never consumed.
 *  4. WEBHOOK_APPLICATION_MISMATCH answered 500, which reads as "retry me".
 *  5. A Stripe `livemode: true` event verified by a test-mode credential was
 *     applied as if it were test data.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../src/modules/billing/providers/stripe-api-version.js';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { billingStatsService } from '../src/modules/billing/stats.service.js';
import { creditsService } from '../src/modules/credits/credits.service.js';
import { applyBillingEvent } from '../src/modules/billing/webhooks/apply.js';
import { subscriptionGrantsService } from '../src/modules/billing/grant.service.js';

const SECRET = 'external-billing-signing-secret-for-tests-0123456789';
const STRIPE_SECRET = 'whsec_apply_integrity';

const stripe = new Stripe('sk_for_signing_only', {
  apiVersion: STRIPE_API_VERSION,
});

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

describe('billing webhook apply integrity', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let appSlug: string;
  let seq = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  async function createApp(slug: string): Promise<string> {
    const ac = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: auth(),
      payload: { name: slug, slug },
    });
    if (ac.statusCode !== 201) throw new Error(`appcreate ${ac.statusCode}: ${ac.body}`);
    return (ac.json().data as { id: string }).id;
  }

  beforeEach(async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const su = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `integrity-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${tag}` },
    });
    if (su.statusCode !== 201) throw new Error(`signup ${su.statusCode}: ${su.body}`);
    token = (su.json().data as { accessToken: string }).accessToken;
    appSlug = `int-${tag}`;
    appId = await createApp(appSlug);
    await billingCredentialsService.upsertCredentials(appId, 'external', { webhookSecret: SECRET }, { mode: 'test' });
    await makePlan('pro');
    await putEntitlement('pro', { kind: 'CREDIT', quantity: 500 });
  });

  async function makePlan(slug: string): Promise<void> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug, name: slug, amount: 2900, kind: 'SUBSCRIPTION', interval: 'MONTH' },
    });
    if (r.statusCode !== 201) throw new Error(`makePlan ${r.statusCode}: ${r.body}`);
  }

  async function putEntitlement(slug: string, body: Record<string, unknown>): Promise<void> {
    const r = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
      headers: auth(),
      payload: body,
    });
    if (r.statusCode !== 200) throw new Error(`putEntitlement ${r.statusCode}: ${r.body}`);
  }

  function post(body: unknown) {
    const payload = JSON.stringify(body);
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex');
    return app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/billing/external/${appSlug}`,
      headers: { 'content-type': 'application/json', 'x-rekey-signature': `t=${t},v1=${v1}` },
      payload,
    });
  }

  function event(type: string, data: unknown, occurredAt: Date = new Date()): Record<string, unknown> {
    seq += 1;
    return { eventId: `evt_${seq}_${type}`, type, occurredAt: occurredAt.toISOString(), data };
  }

  function activated(
    subscriptionId: string,
    subscriber: Record<string, unknown>,
    subscription: Record<string, unknown> = {},
    occurredAt?: Date,
  ): Record<string, unknown> {
    return event(
      'subscription.activated',
      { subscription: { id: subscriptionId, plan: 'pro', ...subscription }, subscriber },
      occurredAt,
    );
  }

  async function receiptOf(eventId: unknown) {
    return prisma.webhookEvent.findFirstOrThrow({
      where: { applicationId: appId, providerEventId: String(eventId) },
    });
  }

  async function endUser(email: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: auth(),
      payload: { email, password: 'pw-one-two-three' },
    });
    if (r.statusCode !== 201) throw new Error(`endUser ${r.statusCode}: ${r.body}`);
    return (r.json().data as { id: string }).id;
  }

  async function org(slug: string): Promise<string> {
    const created = await prisma.organization.create({ data: { applicationId: appId, name: slug, slug } });
    return created.id;
  }

  // ------------------------------------------------------ 1. billing subject

  describe('one plan, two organizations, one buyer', () => {
    it('an external activation for a second organization is refused, not rebound onto the first', async () => {
      const euId = await endUser('owner@example.com');
      const org1 = await org('o1');
      const org2 = await org('o2');

      const first = await post(activated('ext_o1', { endUserId: euId, organizationId: org1 }));
      expect(first.json()).toMatchObject({ processed: true });
      const secondBody = activated('ext_o2', { endUserId: euId, organizationId: org2 });
      const second = await post(secondBody);
      expect(second.statusCode).toBe(200);

      const rows = await prisma.subscription.findMany({ where: { applicationId: appId } });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.providerSubId).toBe('ext_o1');
      expect(row.beneficiaryOrgId).toBe(org1);
      const refused = (row.metadata as { refusedGrants?: Array<{ providerSubId: string }> }).refusedGrants;
      expect(refused?.map((g) => g.providerSubId)).toEqual(['ext_o2']);
      expect((await receiptOf(secondBody.eventId)).processingError).toContain(
        'BILLING_SUBSCRIPTION_SUBJECT_CONFLICT',
      );
      expect(await creditsService.getBalance(appId, { organizationId: org2 })).toBe(0);

      // The first id still names the first organization's row.
      await post(event('subscription.canceled', { subscription: { id: 'ext_o1' } }));
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('CANCELED');
    });

    it('the same subscription id naming another organization still renews, keeping the beneficiary', async () => {
      const euId = await endUser('mover@example.com');
      const org1 = await org('m1');
      const org2 = await org('m2');
      await post(
        activated('ext_same', { endUserId: euId, organizationId: org1 }, { currentPeriodEnd: daysFromNow(30).toISOString() }),
      );
      const moved = activated(
        'ext_same',
        { endUserId: euId, organizationId: org2 },
        { currentPeriodEnd: daysFromNow(60).toISOString() },
      );
      await post(moved);
      const row = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } });
      expect(row.beneficiaryOrgId).toBe(org1);
      expect(row.providerSubId).toBe('ext_same');
      expect(await creditsService.getBalance(appId, { organizationId: org1 })).toBe(1000);
      expect(await creditsService.getBalance(appId, { organizationId: org2 })).toBe(0);
      const note = (await receiptOf(moved.eventId)).processingError;
      expect(note).toContain('subject change ignored');
      expect(note).not.toContain('BILLING_SUBSCRIPTION_SUBJECT_CONFLICT');
    });

    it('a personal subscription renewed under its own id naming an organization applies and stays personal', async () => {
      const euId = await endUser('personal@example.com');
      const org1 = await org('p1');
      await post(activated('ext_personal', { endUserId: euId }, { currentPeriodEnd: daysFromNow(30).toISOString() }));
      expect(await creditsService.getBalance(appId, { endUserId: euId })).toBe(500);
      const renewal = activated(
        'ext_personal',
        { endUserId: euId, organizationId: org1 },
        { currentPeriodEnd: daysFromNow(60).toISOString() },
      );
      const res = await post(renewal);
      expect(res.statusCode).toBe(200);
      const row = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } });
      expect(row.beneficiaryOrgId).toBeNull();
      expect(await creditsService.getBalance(appId, { endUserId: euId })).toBe(1000);
      expect(await creditsService.getBalance(appId, { organizationId: org1 })).toBe(0);
      expect((await receiptOf(renewal.eventId)).processingError).toContain('subject change ignored');
    });

    it('a renewal or recovery that omits the organization applies to the same subscription id', async () => {
      const euId = await endUser('omit@example.com');
      const org1 = await org('om1');
      await post(
        activated('ext_omit', { endUserId: euId, organizationId: org1 }, { currentPeriodEnd: daysFromNow(30).toISOString() }),
      );
      expect(await creditsService.getBalance(appId, { organizationId: org1 })).toBe(500);

      const renewal = activated('ext_omit', { endUserId: euId }, { currentPeriodEnd: daysFromNow(60).toISOString() });
      await post(renewal);
      expect((await receiptOf(renewal.eventId)).processingError).toBeNull();
      expect(await creditsService.getBalance(appId, { organizationId: org1 })).toBe(1000);

      await post(event('subscription.past_due', { subscription: { id: 'ext_omit' } }));
      await post(activated('ext_omit', { endUserId: euId }));
      const row = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } });
      expect(row.status).toBe('ACTIVE');
      expect(row.beneficiaryOrgId).toBe(org1);
    });

    it('a feature-only free plan activated for a second organization does not answer with the first one\'s row', async () => {
      const r = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/plans`,
        headers: auth(),
        payload: { slug: 'free', name: 'free', amount: 0, kind: 'SUBSCRIPTION', interval: 'MONTH' },
      });
      expect(r.statusCode).toBe(201);
      await putEntitlement('free', { kind: 'FEATURE', key: 'tier', valueType: 'STRING', value: 'community' });
      const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
      const updated = await prisma.application.update({
        where: { id: appId },
        data: {
          billingConfig: { ...(application.billingConfig as Record<string, unknown>), defaultPlanSlug: 'free' },
        },
      });
      const euId = await endUser('free@example.com');
      const org1 = await org('f1');
      const org2 = await org('f2');
      const first = await subscriptionGrantsService.activateFreePlan({
        application: updated,
        endUserId: euId,
        organizationId: org1,
      });
      expect(first.activated).toBe(true);
      const second = await subscriptionGrantsService.activateFreePlan({
        application: updated,
        endUserId: euId,
        organizationId: org2,
      });
      expect(second.activated).toBe(false);
      expect(second.subscription).toBeNull();
    });

    it('eight racing operator grants for eight organizations: one wins, the losers get 409, never its row', async () => {
      const euId = await endUser('racegrant@example.com');
      const orgs: string[] = [];
      for (let i = 0; i < 8; i++) orgs.push(await org(`rg${i}`));
      const results = await Promise.all(
        orgs.map((organizationId) =>
          app.inject({
            method: 'POST',
            url: `/api/v1/tenant/applications/${appId}/end-users/${euId}/subscriptions`,
            headers: auth(),
            payload: { planSlug: 'pro', organizationId },
          }),
        ),
      );
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      const losers = results.filter((r) => r.statusCode !== 201);
      expect(losers.map((r) => r.statusCode)).toEqual(Array(7).fill(409));
      for (const r of losers) {
        expect((r.json() as { error: { code: string } }).error.code).toBe('BILLING_SUBSCRIPTION_SUBJECT_CONFLICT');
      }
    });

    it('the operator grant for a second organization answers 409 instead of the first one\'s row', async () => {
      const euId = await endUser('granted@example.com');
      const org1 = await org('g1');
      const org2 = await org('g2');
      const grant = (organizationId: string) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${appId}/end-users/${euId}/subscriptions`,
          headers: auth(),
          payload: { planSlug: 'pro', organizationId },
        });
      expect((await grant(org1)).statusCode).toBe(201);
      const res = await grant(org2);
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('BILLING_SUBSCRIPTION_SUBJECT_CONFLICT');
      // Same subject again is still the idempotent no-op.
      expect((await grant(org1)).statusCode).toBe(200);
    });
  });

  describe('an Application billed per organization', () => {
    beforeEach(async () => {
      const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
      await prisma.application.update({
        where: { id: appId },
        data: {
          billingConfig: { ...(application.billingConfig as Record<string, unknown>), billingSubject: 'org' },
        },
      });
    });

    it('applies a renewal under the same subscription id that omits the organization', async () => {
      const euId = await endUser('orgrenew@example.com');
      const org1 = await org('or1');
      await post(
        activated('ext_orgrenew', { endUserId: euId, organizationId: org1 }, { currentPeriodEnd: daysFromNow(30).toISOString() }),
      );
      const end = daysFromNow(60);
      const renewal = activated('ext_orgrenew', { endUserId: euId }, { currentPeriodEnd: end.toISOString() });
      const res = await post(renewal);

      expect(res.statusCode, res.body).toBe(200);
      expect((await receiptOf(renewal.eventId)).processingError).toBeNull();
      const row = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } });
      expect(row.beneficiaryOrgId).toBe(org1);
      expect(row.currentPeriodEnd?.toISOString()).toBe(end.toISOString());
      expect(await creditsService.getBalance(appId, { organizationId: org1 })).toBe(1000);
    });

    it('keeps the organization when a cancelled subscription is reactivated under its id without one', async () => {
      const euId = await endUser('orgback@example.com');
      const org1 = await org('ob1');
      await post(activated('ext_orgback', { email: 'orgback@example.com', organizationId: org1 }));
      await post(event('subscription.canceled', { subscription: { id: 'ext_orgback' } }));
      const res = await post(activated('ext_orgback', { email: 'orgback@example.com' }));

      expect(res.statusCode, res.body).toBe(200);
      const row = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId, endUserId: euId } });
      expect(row.status).toBe('ACTIVE');
      expect(row.beneficiaryOrgId).toBe(org1);
    });

    it('fails a new subscription without an organization retryably, and a corrected re-send applies', async () => {
      const euId = await endUser('orgnew@example.com');
      const org1 = await org('on1');
      const body = activated('ext_orgnew', { endUserId: euId });
      const res = await post(body);

      // 500, so the sender retries: the operator can fix this by billing per user.
      expect(res.statusCode, res.body).toBe(500);
      const receipt = await receiptOf(body.eventId);
      expect(receipt.processingError).toContain('bills per organization');
      expect(receipt.processedAt).toBeNull();

      const fixed = { ...body, data: { ...(body.data as Record<string, unknown>), subscriber: { endUserId: euId, organizationId: org1 } } };
      const retry = await post(fixed);
      expect(retry.statusCode, retry.body).toBe(200);
      const row = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } });
      expect(row.beneficiaryOrgId).toBe(org1);
    });

    it('still requires the organization when the same id arrives for a different subscriber', async () => {
      const owner = await endUser('orgowner@example.com');
      const other = await endUser('orgother@example.com');
      const org1 = await org('oo1');
      await post(activated('ext_orgmove', { endUserId: owner, organizationId: org1 }));
      const res = await post(activated('ext_orgmove', { endUserId: other }));

      expect(res.statusCode, res.body).toBe(500);
      expect((await prisma.webhookEvent.findFirstOrThrow({ where: { applicationId: appId, processedAt: null } })).processingError).toContain('organization');
      const rows = await prisma.subscription.findMany({ where: { applicationId: appId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('ACTIVE');
      expect(rows[0]!.endUserId).toBe(owner);
    });

    it('answers 404 for an organization the Application does not have', async () => {
      const euId = await endUser('orgmissing@example.com');
      const res = await post(activated('ext_orgmissing', { endUserId: euId, organizationId: 'org_does_not_exist' }));
      expect(res.statusCode, res.body).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe('ORGANIZATION_NOT_FOUND');
    });
  });

  // ------------------------------------------------------ 2. ordering

  describe('ordering', () => {
    it('an activation that predates the cancellation does not reopen it or grant credits', async () => {
      const euId = await endUser('ooo@example.com');
      const t0 = Date.now();
      await post(
        activated('ext_ooo', { endUserId: euId }, { currentPeriodEnd: daysFromNow(30).toISOString() }, new Date(t0 - 3000)),
      );
      await post(event('subscription.canceled', { subscription: { id: 'ext_ooo' } }, new Date(t0 - 1000)));
      const late = activated(
        'ext_ooo',
        { endUserId: euId },
        { currentPeriodEnd: daysFromNow(60).toISOString() },
        new Date(t0 - 2000),
      );
      const res = await post(late);
      expect(res.statusCode).toBe(200);

      const row = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } });
      expect(row.status).toBe('CANCELED');
      expect(await creditsService.getBalance(appId, { endUserId: euId })).toBe(500);
      expect((await receiptOf(late.eventId)).processingError).toMatch(/cancel/i);
    });

    it('a cancellation dated by Rekey\'s own clock does not refuse a reactivation from a skewed sender clock', async () => {
      const euId = await endUser('skew@example.com');
      await post(activated('ext_skew', { endUserId: euId }));
      seq += 1;
      // No occurredAt: canceledAt comes from Rekey's clock.
      await post({ eventId: `evt_${seq}_cancel`, type: 'subscription.canceled', data: { subscription: { id: 'ext_skew' } } });
      const row = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } });
      expect(row.status).toBe('CANCELED');
      // The sender's clock runs a few seconds behind Rekey's.
      await post(activated('ext_skew', { endUserId: euId }, {}, new Date(row.canceledAt!.getTime() - 5000)));
      expect((await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } })).status).toBe('ACTIVE');
    });

    it('an activation that happened after the cancellation still reopens it', async () => {
      const euId = await endUser('back@example.com');
      const t0 = Date.now();
      await post(activated('ext_back', { endUserId: euId }, {}, new Date(t0 - 3000)));
      await post(event('subscription.canceled', { subscription: { id: 'ext_back' } }, new Date(t0 - 2000)));
      await post(activated('ext_back', { endUserId: euId }, {}, new Date(t0 - 1000)));
      expect((await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } })).status).toBe('ACTIVE');
    });

    it('a cancellation dated far in the future is dated now, so a genuine reactivation still reopens it', async () => {
      const euId = await endUser('future@example.com');
      await post(activated('ext_future', { endUserId: euId }, {}, new Date(Date.now() - 60_000)));
      const cancel = event('subscription.canceled', { subscription: { id: 'ext_future' } }, daysFromNow(365));
      await post(cancel);

      const row = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } });
      expect(row.status).toBe('CANCELED');
      expect(row.canceledAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect((await receiptOf(cancel.eventId)).processingError).toMatch(/ahead of Rekey's clock/);

      await post(activated('ext_future', { endUserId: euId }, {}, new Date(Date.now() - 1000)));
      expect((await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } })).status).toBe('ACTIVE');
    });

    it('a cancellation dated a minute ahead is still the sender\'s date', async () => {
      const euId = await endUser('drift@example.com');
      await post(activated('ext_drift', { endUserId: euId }));
      const at = new Date(Date.now() + 60_000);
      await post(event('subscription.canceled', { subscription: { id: 'ext_drift' } }, at));
      const row = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } });
      expect(row.canceledAt?.toISOString()).toBe(at.toISOString());
    });

    it('an activation dated far in the future is applied as undated and noted', async () => {
      const euId = await endUser('futureact@example.com');
      const body = activated('ext_futureact', { endUserId: euId }, {}, daysFromNow(30));
      await post(body);
      expect((await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } })).status).toBe('ACTIVE');
      expect((await receiptOf(body.eventId)).processingError).toMatch(/ahead of Rekey's clock/);
    });

    it('a period end restated a few seconds later is the same period: no second refill', async () => {
      const euId = await endUser('jitter@example.com');
      const end = daysFromNow(30);
      await post(activated('ext_jit', { endUserId: euId }, { currentPeriodEnd: end.toISOString() }));
      await post(
        activated('ext_jit', { endUserId: euId }, { currentPeriodEnd: new Date(end.getTime() + 5000).toISOString() }),
      );
      expect(await creditsService.getBalance(appId, { endUserId: euId })).toBe(500);
      const row = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } });
      expect(row.currentPeriodEnd?.toISOString()).toBe(end.toISOString());

      // A real renewal still refills once.
      await post(activated('ext_jit', { endUserId: euId }, { currentPeriodEnd: daysFromNow(60).toISOString() }));
      expect(await creditsService.getBalance(appId, { endUserId: euId })).toBe(1000);
    });
  });

  // ------------------------------------------------------ 3. refunds

  describe('refunds', () => {
    async function paidPayment(id: string, amount: number): Promise<void> {
      const euId = await endUser(`${id}@example.com`);
      await post(activated(`ext_${id}`, { endUserId: euId }));
      await post(event('payment.succeeded', { payment: { id, subscriptionId: `ext_${id}`, amount, currency: 'usd' } }));
    }
    const refund = (id: string, amount: number) =>
      event('payment.refunded', { payment: { id, subscriptionId: `ext_${id}`, amount, currency: 'usd' } });
    const paymentOf = (id: string) =>
      prisma.payment.findFirstOrThrow({ where: { applicationId: appId, providerPaymentId: id } });

    it('accumulates partial refunds, refuses an over-refund, and nets revenue', async () => {
      await paidPayment('pay_r', 2000);

      await post(refund('pay_r', 500));
      let p = await paymentOf('pay_r');
      expect(p.status).toBe('PARTIALLY_REFUNDED');
      expect(p.refundedAmount).toBe(500);

      await post(refund('pay_r', 500));
      p = await paymentOf('pay_r');
      expect(p.status).toBe('PARTIALLY_REFUNDED');
      expect(p.refundedAmount).toBe(1000);
      expect((await billingStatsService.forApplication(appId)).revenueLast30dCents).toBe(1000);

      const over = refund('pay_r', 5000);
      const res = await post(over);
      expect(res.statusCode).toBe(200);
      p = await paymentOf('pay_r');
      expect(p.refundedAmount).toBe(1000);
      expect((await receiptOf(over.eventId)).processingError).toContain('BILLING_REFUND_EXCEEDS_PAYMENT');

      await post(refund('pay_r', 1000));
      p = await paymentOf('pay_r');
      expect(p.status).toBe('REFUNDED');
      expect(p.refundedAmount).toBe(2000);
      const stats = await billingStatsService.forApplication(appId);
      expect(stats.revenueLast30dCents).toBe(0);
      expect(stats.monthlyRevenue.at(-1)?.amountCents).toBe(0);
    });

    it('eight concurrent refunds neither lose an update nor overshoot the payment', async () => {
      await paidPayment('pay_race', 2000);
      const notes: string[] = [];
      const ctx = { log: app.log, provider: 'external', note: (t: string) => notes.push(t) };
      const racer = (i: number) =>
        applyBillingEvent(
          {
            type: 'payment.refunded',
            providerEventId: `evt_race_${i}`,
            applicationId: appId,
            providerPaymentId: 'pay_race',
            providerSubscriptionId: 'ext_pay_race',
            amount: 500,
            currency: 'USD',
            description: null,
            raw: {},
          },
          ctx,
        );
      await Promise.all(Array.from({ length: 8 }, (_, i) => racer(i)));
      const p = await paymentOf('pay_race');
      expect(p.refundedAmount).toBe(2000);
      expect(p.status).toBe('REFUNDED');
      expect(notes.filter((n) => n.startsWith('BILLING_REFUND_EXCEEDS_PAYMENT'))).toHaveLength(4);
    });

    it('re-attempting an already applied refund event does not count it twice', async () => {
      await paidPayment('pay_again', 2000);
      const ev = {
        type: 'payment.refunded' as const,
        providerEventId: 'evt_refund_retry',
        applicationId: appId,
        providerPaymentId: 'pay_again',
        providerSubscriptionId: 'ext_pay_again',
        amount: 300,
        currency: 'USD',
        description: null,
        raw: {},
      };
      await applyBillingEvent(ev, { log: app.log });
      await applyBillingEvent(ev, { log: app.log });
      expect((await paymentOf('pay_again')).refundedAmount).toBe(300);
    });

    it('a refund for a payment Rekey never recorded is noted, not guessed at', async () => {
      const r = refund('pay_unknown', 100);
      await post(r);
      expect((await receiptOf(r.eventId)).processingError).toMatch(/no recorded payment/i);
    });
  });

  // ------------------------------------------------------ Stripe

  describe('Stripe', () => {
    beforeEach(async () => {
      await billingCredentialsService.upsertCredentials(
        appId,
        'stripe',
        { apiKey: 'sk_test_for_ci_only', webhookSecret: STRIPE_SECRET },
        { enabled: true, mode: 'test' },
      );
    });

    function stripePost(body: Record<string, unknown>, slug = appSlug) {
      const payload = JSON.stringify(body);
      return app.inject({
        method: 'POST',
        url: `/api/v1/webhooks/billing/stripe/${slug}`,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_SECRET }),
        },
        payload,
      });
    }

    function invoicePaid(id: string, amount: number, extra: Record<string, unknown> = {}, applicationId = appId) {
      seq += 1;
      return {
        id: `evt_inv_${seq}`,
        type: 'invoice.paid',
        livemode: false,
        ...extra,
        data: {
          object: {
            id,
            object: 'invoice',
            amount_paid: amount,
            currency: 'usd',
            subscription: 'sub_stripe_unknown',
            billing_reason: 'subscription_cycle',
            metadata: { applicationId },
          },
        },
      };
    }

    function chargeRefunded(invoice: string, amount: number, amountRefunded: number) {
      seq += 1;
      return {
        id: `evt_ch_${seq}`,
        type: 'charge.refunded',
        livemode: false,
        data: {
          object: {
            id: `ch_${invoice}`,
            object: 'charge',
            amount,
            amount_refunded: amountRefunded,
            currency: 'usd',
            invoice,
            payment_intent: `pi_${invoice}`,
            metadata: {},
          },
        },
      };
    }

    it('charge.refunded records the cumulative refunded amount on the invoice payment', async () => {
      await stripePost(invoicePaid('in_refund', 2000));
      const first = await stripePost(chargeRefunded('in_refund', 2000, 700));
      expect(first.statusCode).toBe(200);
      let p = await prisma.payment.findFirstOrThrow({ where: { applicationId: appId, providerPaymentId: 'in_refund' } });
      expect(p.status).toBe('PARTIALLY_REFUNDED');
      expect(p.refundedAmount).toBe(700);

      // Stripe reports the running total, so a later event carries the sum.
      await stripePost(chargeRefunded('in_refund', 2000, 700));
      await stripePost(chargeRefunded('in_refund', 2000, 2000));
      p = await prisma.payment.findFirstOrThrow({ where: { applicationId: appId, providerPaymentId: 'in_refund' } });
      expect(p.status).toBe('REFUNDED');
      expect(p.refundedAmount).toBe(2000);
    });

    it('a livemode event verified by a test-mode credential is refused retryably and applies once the credential is fixed', async () => {
      const body = invoicePaid('in_live', 2000, { livemode: true });
      const res = await stripePost(body);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('WEBHOOK_MODE_MISMATCH');
      expect(await prisma.payment.count({ where: { applicationId: appId, providerPaymentId: 'in_live' } })).toBe(0);
      const receipt = await receiptOf(body.id);
      expect(receipt.processingError).toContain('WEBHOOK_MODE_MISMATCH');
      expect(receipt.processedAt).toBeNull();

      // The same event in the credential's own mode applies normally.
      await stripePost(invoicePaid('in_test', 2000));
      expect(await prisma.payment.count({ where: { applicationId: appId, providerPaymentId: 'in_test' } })).toBe(1);

      // The operator saves live credentials; Stripe's retry of the SAME event
      // is re-attempted, not skipped as a duplicate.
      await billingCredentialsService.upsertCredentials(
        appId,
        'stripe',
        { apiKey: 'sk_live_for_ci_only', webhookSecret: STRIPE_SECRET },
        { enabled: true, mode: 'live' },
      );
      const retry = await stripePost(body);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ processed: true });
      expect(await prisma.payment.count({ where: { applicationId: appId, providerPaymentId: 'in_live' } })).toBe(1);
      const applied = await receiptOf(body.id);
      expect(applied.processedAt).not.toBeNull();
      expect(applied.processingError).toBeNull();
      expect(applied.mode).toBe('live');
    });

    it('an event naming another Application answers 400, records why, and changes nothing', async () => {
      const otherId = await createApp(`${appSlug}-b`);
      const body = invoicePaid('in_cross', 2000, {}, otherId);
      const res = await stripePost(body);
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('WEBHOOK_APPLICATION_MISMATCH');
      expect(await prisma.payment.count({ where: { providerPaymentId: 'in_cross' } })).toBe(0);
      expect((await receiptOf(body.id)).processingError).toContain('WEBHOOK_APPLICATION_MISMATCH');
    });
  });
});
