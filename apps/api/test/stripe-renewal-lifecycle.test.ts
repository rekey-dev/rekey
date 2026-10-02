/**
 * Stripe renewal traffic as Stripe actually sends it, through the pipeline.
 *
 * Routing invoices by the subscription snapshot turns on the payment appliers
 * for every Stripe renewal, so these pin the shapes real traffic has that the
 * older fixtures did not: Stripe retries the SAME invoice after a failure, the
 * first invoice can beat `checkout.session.completed`, a trial's first invoice
 * is $0, failures can arrive for a subscription that is already over, and the
 * failure event and the past_due status mirror reach dunning together.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import type { Subscription } from '@prisma/client';
import { STRIPE_API_VERSION } from '../src/modules/billing/providers/stripe-api-version.js';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';
import { dunningService } from '../src/modules/billing/dunning.service.js';
import { creditsService } from '../src/modules/credits/credits.service.js';

const STRIPE_SECRET = 'whsec_renewal_lifecycle';
const signer = new Stripe('sk_for_signing_only', { apiVersion: STRIPE_API_VERSION });

describe('Stripe renewal lifecycle', () => {
  let app: FastifyInstance;
  let appId: string;
  let appSlug: string;
  let planId: string;
  let endUserId: string;
  let endpointId: string;
  let seq = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const su = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `renew-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${tag}` },
    });
    if (su.statusCode !== 201) throw new Error(`signup ${su.statusCode}: ${su.body}`);
    const token = (su.json().data as { accessToken: string }).accessToken;
    appSlug = `renew-${tag}`;
    const ac = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: appSlug, slug: appSlug },
    });
    if (ac.statusCode !== 201) throw new Error(`appcreate ${ac.statusCode}: ${ac.body}`);
    appId = (ac.json().data as { id: string }).id;
    await billingCredentialsService.upsertCredentials(
      appId,
      'stripe',
      { apiKey: 'sk_test_renewal_lifecycle', webhookSecret: STRIPE_SECRET },
      { enabled: true, mode: 'test' },
    );
    await applicationsService.updateBillingConfig({ applicationId: appId, patch: { dunningEnabled: true } });
    planId = (
      await prisma.plan.create({
        data: { applicationId: appId, slug: 'pro', name: 'Pro', amount: 999, currency: 'USD', kind: 'SUBSCRIPTION', interval: 'MONTH' },
      })
    ).id;
    endUserId = (await prisma.endUser.create({ data: { applicationId: appId, email: `buyer-${tag}@example.com` } })).id;
    endpointId = (
      await webhookService.createEndpoint({ applicationId: appId, url: 'https://example.invalid/hook', events: ['*'] })
    ).endpoint.id;
  });

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);
  const DAY_SECONDS = 24 * 60 * 60;

  function post(type: string, object: Record<string, unknown>, id = `evt_renew_${++seq}`, created = nowSeconds()) {
    const payload = JSON.stringify({ id, object: 'event', type, created, livemode: false, data: { object } });
    return app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/billing/stripe/${appSlug}`,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signer.webhooks.generateTestHeaderString({ payload, secret: STRIPE_SECRET }),
      },
      payload,
    });
  }

  /** A basil-shaped invoice routed by its subscription snapshot, as Stripe sends it. */
  function invoice(id: string, providerSubId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      object: 'invoice',
      amount_paid: 999,
      amount_due: 999,
      currency: 'usd',
      billing_reason: 'subscription_cycle',
      metadata: {},
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: providerSubId, metadata: { applicationId: appId } },
      },
      ...extra,
    };
  }

  function subscription(status: Subscription['status'], providerSubId: string | null, metadata = {}) {
    return prisma.subscription.create({
      data: { applicationId: appId, endUserId, planId, status, provider: 'stripe', providerSubId, metadata },
    });
  }

  const deliveries = (eventType: string) => prisma.webhookDelivery.count({ where: { endpointId, eventType } });
  const receipt = (eventId: string) =>
    prisma.webhookEvent.findFirstOrThrow({ where: { applicationId: appId, providerEventId: eventId } });

  describe('a renewal that fails and is then collected on the same invoice', () => {
    it('turns the FAILED payment SUCCEEDED, reactivates, announces and recovers dunning', async () => {
      const sub = await subscription('ACTIVE', 'sub_retry');
      expect((await post('invoice.payment_failed', invoice('in_retry', 'sub_retry'))).statusCode).toBe(200);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('PAST_DUE');

      const paid = await post('invoice.paid', invoice('in_retry', 'sub_retry', { amount_paid: 999 }));
      expect(paid.statusCode).toBe(200);
      expect(paid.json()).toMatchObject({ processed: true });

      const payments = await prisma.payment.findMany({ where: { applicationId: appId, providerPaymentId: 'in_retry' } });
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({ status: 'SUCCEEDED', amount: 999, currency: 'USD', subscriptionId: sub.id });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('ACTIVE');
      expect(await deliveries('payment.succeeded')).toBe(1);
      expect(await deliveries('subscription.activated')).toBe(1);
      expect((await prisma.dunningCase.findFirstOrThrow({ where: { subscriptionId: sub.id } })).status).toBe('RECOVERED');

      // A replay of the paid event changes nothing and announces nothing.
      await post('invoice.paid', invoice('in_retry', 'sub_retry'), `evt_replay_${seq}`);
      expect(await deliveries('payment.succeeded')).toBe(1);
    });

    it('counts each failed retry of the same invoice once, and a replayed event not at all', async () => {
      const sub = await subscription('ACTIVE', 'sub_fail_twice');
      await post('invoice.payment_failed', invoice('in_fail_twice', 'sub_fail_twice'), 'evt_fail_1');
      await post('invoice.payment_failed', invoice('in_fail_twice', 'sub_fail_twice'), 'evt_fail_2');
      const caseRow = await prisma.dunningCase.findFirstOrThrow({ where: { subscriptionId: sub.id } });
      expect(caseRow.failedAttempts).toBe(2);
      expect(await prisma.payment.count({ where: { applicationId: appId, providerPaymentId: 'in_fail_twice' } })).toBe(1);
      expect(await deliveries('payment.failed')).toBe(1);

      // The pipeline skips an already-processed event id before the applier,
      // so force the applier's own replay check with a re-attempt.
      await prisma.webhookEvent.updateMany({
        where: { applicationId: appId, providerEventId: 'evt_fail_2' },
        data: { processedAt: null },
      });
      await post('invoice.payment_failed', invoice('in_fail_twice', 'sub_fail_twice'), 'evt_fail_2');
      expect((await prisma.dunningCase.findFirstOrThrow({ where: { subscriptionId: sub.id } })).failedAttempts).toBe(2);
    });

    it('a failure arriving after the invoice was paid does not undo it', async () => {
      const sub = await subscription('ACTIVE', 'sub_late_fail');
      await post('invoice.paid', invoice('in_late_fail', 'sub_late_fail'));
      await post('invoice.payment_failed', invoice('in_late_fail', 'sub_late_fail'));
      expect(
        (await prisma.payment.findFirstOrThrow({ where: { applicationId: appId, providerPaymentId: 'in_late_fail' } })).status,
      ).toBe('SUCCEEDED');
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('ACTIVE');
      expect(await prisma.dunningCase.count({ where: { subscriptionId: sub.id } })).toBe(0);
    });
  });

  describe('the first invoice arriving before its checkout', () => {
    it('answers 500 with the receipt unprocessed, then applies against the linked row after checkout.session.completed', async () => {
      const sub = await subscription('PENDING', null, { checkoutSessionId: 'cs_early' });
      const first = invoice('in_early', 'sub_early', { billing_reason: 'subscription_create' });

      const early = await post('invoice.paid', first, 'evt_early_invoice');
      expect(early.statusCode).toBe(500);
      expect((await receipt('evt_early_invoice')).processedAt).toBeNull();
      expect(await prisma.payment.count({ where: { applicationId: appId } })).toBe(0);
      expect(await prisma.unappliedPayment.count({ where: { applicationId: appId } })).toBe(0);

      const completed = await post('checkout.session.completed', {
        id: 'cs_early',
        mode: 'subscription',
        payment_status: 'paid',
        subscription: 'sub_early',
        metadata: { applicationId: appId },
      });
      expect(completed.statusCode).toBe(200);

      const retried = await post('invoice.paid', first, 'evt_early_invoice');
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toMatchObject({ processed: true });
      const payment = await prisma.payment.findFirstOrThrow({ where: { applicationId: appId, providerPaymentId: 'in_early' } });
      expect(payment).toMatchObject({ status: 'SUCCEEDED', subscriptionId: sub.id });
      expect(await prisma.unappliedPayment.count({ where: { applicationId: appId } })).toBe(0);
    });

    it('waits for async_payment_succeeded when the checkout completed unpaid', async () => {
      const sub = await subscription('PENDING', null, { checkoutSessionId: 'cs_async' });
      const session = {
        id: 'cs_async',
        mode: 'subscription',
        subscription: 'sub_async',
        metadata: { applicationId: appId },
      };
      await post('checkout.session.completed', { ...session, payment_status: 'unpaid' });
      const first = invoice('in_async', 'sub_async', { billing_reason: 'subscription_create' });
      expect((await post('invoice.paid', first, 'evt_async_invoice')).statusCode).toBe(500);

      expect((await post('checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' })).statusCode).toBe(200);
      expect((await post('invoice.paid', first, 'evt_async_invoice')).statusCode).toBe(200);
      expect(
        (await prisma.payment.findFirstOrThrow({ where: { applicationId: appId, providerPaymentId: 'in_async' } })).subscriptionId,
      ).toBe(sub.id);
      expect(await prisma.unappliedPayment.count({ where: { applicationId: appId } })).toBe(0);
    });

    it('stops deferring an unmatched first invoice once the event is a day old, and files it as unapplied', async () => {
      const first = (id: string) => invoice(id, `sub_${id}`, { billing_reason: 'subscription_create' });
      const young = await post('invoice.paid', first('in_young'), 'evt_young', nowSeconds() - DAY_SECONDS + 300);
      expect(young.statusCode).toBe(500);
      expect(await prisma.unappliedPayment.count({ where: { applicationId: appId } })).toBe(0);

      const old = await post('invoice.paid', first('in_old'), 'evt_old', nowSeconds() - DAY_SECONDS - 300);
      expect(old.statusCode).toBe(200);
      expect((await receipt('evt_old')).processedAt).not.toBeNull();
      const filed = await prisma.unappliedPayment.findMany({ where: { applicationId: appId } });
      expect(filed).toHaveLength(1);
      expect(
        (await prisma.payment.findFirstOrThrow({ where: { applicationId: appId, providerPaymentId: 'in_old' } })).id,
      ).toBe(filed[0]!.paymentId);
    });

    it('a renewal that matches nothing is still filed as unapplied, not deferred', async () => {
      expect((await post('invoice.paid', invoice('in_orphan', 'sub_orphan'))).statusCode).toBe(200);
      expect(await prisma.unappliedPayment.count({ where: { applicationId: appId } })).toBe(1);
    });
  });

  describe('trials', () => {
    it('a $0 first invoice records nothing and leaves the trial alone', async () => {
      const sub = await subscription('TRIALING', 'sub_trial');
      const res = await post('invoice.paid', invoice('in_trial', 'sub_trial', { amount_paid: 0, billing_reason: 'subscription_create' }));
      expect(res.statusCode).toBe(200);
      expect(await prisma.payment.count({ where: { applicationId: appId } })).toBe(0);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('TRIALING');
      expect(await deliveries('subscription.activated')).toBe(0);
    });

    it('a $0 renewal still refills credits each period', async () => {
      const plan = await prisma.plan.create({
        data: { applicationId: appId, slug: 'credits', name: 'Credits', amount: 999, currency: 'USD', kind: 'SUBSCRIPTION', interval: 'MONTH' },
      });
      await prisma.planEntitlement.create({ data: { planId: plan.id, kind: 'CREDIT', key: '', quantity: 500 } });
      const sub = await prisma.subscription.create({
        data: {
          applicationId: appId,
          endUserId,
          planId: plan.id,
          status: 'ACTIVE',
          provider: 'stripe',
          providerSubId: 'sub_free_credits',
          currentPeriodEnd: new Date('2027-01-31T00:00:00.000Z'),
        },
      });
      const covered = (id: string) => invoice(id, 'sub_free_credits', { amount_paid: 0 });

      expect((await post('invoice.paid', covered('in_free_1'))).statusCode).toBe(200);
      expect(await creditsService.getBalance(appId, { endUserId })).toBe(500);
      await prisma.subscription.update({ where: { id: sub.id }, data: { currentPeriodEnd: new Date('2027-02-28T00:00:00.000Z') } });
      expect((await post('invoice.paid', covered('in_free_2'))).statusCode).toBe(200);
      expect(await creditsService.getBalance(appId, { endUserId })).toBe(1000);
      expect(
        (await prisma.payment.findFirstOrThrow({ where: { applicationId: appId, providerPaymentId: 'in_free_2' } })),
      ).toMatchObject({ status: 'SUCCEEDED', amount: 0 });
    });

    it('a $0 renewal still extends a TIMED licence', async () => {
      const plan = await prisma.plan.create({
        data: {
          applicationId: appId,
          slug: 'timed',
          name: 'Timed',
          amount: 999,
          currency: 'USD',
          kind: 'SUBSCRIPTION',
          interval: 'MONTH',
          licenseDurationDays: 30,
        },
      });
      await prisma.planEntitlement.create({ data: { planId: plan.id, kind: 'LICENSE', key: '', licenseKind: 'TIMED' } });
      const sub = await prisma.subscription.create({
        data: {
          applicationId: appId,
          endUserId,
          planId: plan.id,
          status: 'ACTIVE',
          provider: 'stripe',
          providerSubId: 'sub_free_timed',
          currentPeriodEnd: new Date('2027-01-31T00:00:00.000Z'),
        },
      });
      const covered = (id: string) => invoice(id, 'sub_free_timed', { amount_paid: 0 });

      await post('invoice.paid', covered('in_timed_1'));
      const issued = await prisma.license.findFirstOrThrow({ where: { applicationId: appId, planId: plan.id } });
      await prisma.subscription.update({ where: { id: sub.id }, data: { currentPeriodEnd: new Date('2027-02-28T00:00:00.000Z') } });
      await post('invoice.paid', covered('in_timed_2'));
      const extended = await prisma.license.findUniqueOrThrow({ where: { id: issued.id } });
      expect(extended.expiresAt!.getTime() - issued.expiresAt!.getTime()).toBe(30 * 86_400_000);
    });

    it('a paid invoice on a trialing row is recorded without promoting it', async () => {
      const sub = await subscription('TRIALING', 'sub_trial_paid');
      await post('invoice.paid', invoice('in_trial_paid', 'sub_trial_paid'));
      expect(
        (await prisma.payment.findFirstOrThrow({ where: { applicationId: appId, providerPaymentId: 'in_trial_paid' } })).status,
      ).toBe('SUCCEEDED');
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('TRIALING');
      expect(await deliveries('subscription.activated')).toBe(0);
    });
  });

  it('a failure for a canceled subscription is recorded but does not revive it or open dunning', async () => {
    for (const status of ['CANCELED', 'EXPIRED'] as const) {
      const providerSubId = `sub_dead_${status}`;
      endUserId = (await prisma.endUser.create({ data: { applicationId: appId, email: `dead-${status}@example.com` } })).id;
      const sub = await subscription(status, providerSubId);
      expect((await post('invoice.payment_failed', invoice(`in_dead_${status}`, providerSubId))).statusCode).toBe(200);
      expect(
        (await prisma.payment.findFirstOrThrow({ where: { applicationId: appId, providerPaymentId: `in_dead_${status}` } })).status,
      ).toBe('FAILED');
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(status);
      expect(await prisma.dunningCase.count({ where: { subscriptionId: sub.id } })).toBe(0);
    }
    expect(await deliveries('subscription.past_due')).toBe(0);
  });

  it('eight concurrent openers produce one dunning case and one day-0 reminder', async () => {
    const sub = await subscription('PAST_DUE', 'sub_race');
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0
          ? dunningService.recordPaymentFailure({ subscriptionId: sub.id })
          : dunningService.ensureCaseOpen({ subscriptionId: sub.id }),
      ),
    );
    const cases = await prisma.dunningCase.findMany({ where: { subscriptionId: sub.id } });
    expect(cases).toHaveLength(1);
    expect(await deliveries('dunning.case_opened')).toBe(1);
    // The day-0 reminder is sent off the request path; give every racer's
    // send time to land before counting.
    const deadline = Date.now() + 2000;
    while (
      Date.now() < deadline &&
      (await prisma.emailLog.count({ where: { applicationId: appId, eventKey: 'billing_payment_failed_reminder' } })) === 0
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(await prisma.emailLog.count({ where: { applicationId: appId, eventKey: 'billing_payment_failed_reminder' } })).toBe(1);
  });
});
