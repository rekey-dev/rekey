/**
 * What a charge leaves behind: the billing log of a checkout from opened to
 * paid, a charge that matches nothing recorded as unverified rather than
 * dropped, and the plan a PayPal renewal names.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { drainBillingEventOutbox } from '../src/modules/billing-log/index.js';
import { STRIPE_API_VERSION } from '../src/modules/billing/providers/stripe-api-version.js';
import { paypalModule } from '../src/modules/billing/providers/modules/paypal/index.js';
import type { DomainBillingEvent, TranslateCtx } from '../src/modules/billing/providers/module-types.js';
import { applyBillingEvent } from '../src/modules/billing/webhooks/apply.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';
import { dunningService } from '../src/modules/billing/dunning.service.js';
import { withRenewalPriceIds } from '../src/modules/billing/webhooks/renewal-price-id.js';
import { fakePaypal, fakeStripe } from './fakes/billing-providers.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const stripe = new Stripe('sk_for_signing_only', { apiVersion: STRIPE_API_VERSION });
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

function translateCtx(extra: Partial<TranslateCtx> = {}): TranslateCtx {
  return { log: quiet, applicationId: 'app_1', providerEventId: 'evt_1', ...extra };
}
describe('charge records', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await twoCurrencyWorld(app);
  });
  afterEach(() => {
    delete (fakeStripe as { refundPayment?: unknown }).refundPayment;
    vi.restoreAllMocks();
  });

  const ctx = () => ({ log: quiet, provider: 'stripe', note: vi.fn() });
  const events = (where: Record<string, unknown> = {}) =>
    prisma.billingEvent.findMany({ where: { applicationId: w.applicationId, ...where }, orderBy: { seq: 'asc' } });
  const paymentOf = (providerPaymentId: string) =>
    prisma.payment.findUniqueOrThrow({
      where: { applicationId_providerPaymentId: { applicationId: w.applicationId, providerPaymentId } },
      include: { refunds: { orderBy: { createdAt: 'asc' } }, unapplied: true },
    });

  function fireStripe(type: string, object: Record<string, unknown>, id = `evt_${randomUUID()}`) {
    const payload = JSON.stringify({
      id,
      object: 'event',
      type,
      created: Math.floor(Date.now() / 1000),
      data: { object: { metadata: { applicationId: w.applicationId }, ...object } },
    });
    return app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${w.slug}`,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_ci_only' }),
      },
      payload,
    });
  }

  /** A paid USD subscription through Stripe: checkout, completion, one renewal invoice of 2000. */
  async function paidSubscription(invoiceId = 'in_paid'): Promise<{ subscriptionId: string; providerSubId: string; sessionId: string }> {
    const { row } = await w.sessionOf(await w.checkout());
    const providerSubId = `sub_${randomUUID().slice(0, 8)}`;
    const done = await fireStripe('checkout.session.completed', { id: row.providerSessionId, mode: 'subscription', subscription: providerSubId });
    expect(done.statusCode, done.body).toBe(200);
    const paid = await fireStripe('invoice.paid', {
      id: invoiceId,
      subscription: providerSubId,
      amount_paid: 2000,
      currency: 'usd',
      billing_reason: 'subscription_cycle',
    });
    expect(paid.statusCode, paid.body).toBe(200);
    return { subscriptionId: row.subscriptionId, providerSubId, sessionId: row.id };
  }

  describe('the billing log of a checkout, from opened to paid', () => {
    it('records opened, completed, priced, activated and the payment, each once across a redelivery', async () => {
      const res = await w.checkout({ country: 'IN' });
      const { row } = await w.sessionOf(res);
      const opened = await events({ type: 'checkout.opened' });
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ checkoutSessionId: row.id, currency: 'INR', amount: 149900, provider: 'razorpay', tier: 'DIAGNOSTIC' });
      expect(opened[0]!.data).toMatchObject({
        planSlug: 'pro',
        priceCharged: { planPriceId: w.inrPriceId, currency: 'INR', amount: 149900 },
        priceShown: { planPriceId: w.inrPriceId, currency: 'INR', amount: 149900 },
        reason: 'country',
        discountAmount: 0,
        buyerCountry: 'IN',
      });

      const charged = {
        event: 'subscription.charged',
        payload: {
          subscription: { entity: { id: row.providerSessionId, status: 'active', paid_count: 1 } },
          payment: { entity: { id: 'pay_first', amount: 149900, currency: 'INR' } },
        },
      };
      const activated = { event: 'subscription.activated', payload: { subscription: { entity: { id: row.providerSessionId, status: 'active' } } } };
      expect((await w.razorpayWebhook(activated)).statusCode).toBe(200);
      expect((await w.razorpayWebhook(charged)).statusCode).toBe(200);
      // The same two events again: nothing more is written.
      expect((await w.razorpayWebhook(activated)).statusCode).toBe(200);
      expect((await w.razorpayWebhook(charged)).statusCode).toBe(200);

      const trail = await events({ tier: 'PERMANENT', subscriptionId: row.subscriptionId });
      expect(trail.map((e) => e.type)).toEqual(['subscription.priced', 'checkout.completed', 'subscription.activated', 'payment.recorded']);
      const [priced, completed, , recorded] = trail;
      expect(priced!.data).toMatchObject({ before: null, after: { planPriceId: w.inrPriceId, currency: 'INR', amount: 149900 }, cause: 'checkout' });
      expect(completed).toMatchObject({ checkoutSessionId: row.id, currency: 'INR', amount: 149900, actorType: 'PROVIDER' });
      expect(completed!.data).toMatchObject({ planSlug: 'pro', discountAmount: 0, providerSessionId: row.providerSessionId });
      const payment = await paymentOf('pay_first');
      expect(payment).toMatchObject({ amount: 149900, currency: 'INR', verification: 'VERIFIED', planPriceId: w.inrPriceId, unitAmount: 149900, provider: 'razorpay' });
      expect(recorded).toMatchObject({ paymentId: payment.id, currency: 'INR', amount: 149900 });
      expect(recorded!.data).toMatchObject({ verification: 'verified', priceCharged: { planPriceId: w.inrPriceId, currency: 'INR', amount: 149900 } });
    });

    it('a refused checkout is logged with its code, once an hour however often it is retried', async () => {
      for (let i = 0; i < 3; i += 1) {
        const res = await w.checkout({ planSlug: 'no-such-plan' });
        expect(res.statusCode).toBe(404);
      }
      const refused = await events({ type: 'checkout.refused' });
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ tier: 'DIAGNOSTIC', endUserId: w.buyer.id, actorType: 'END_USER' });
      expect(refused[0]!.data).toMatchObject({ planSlug: 'no-such-plan', code: 'PLAN_NOT_FOUND' });
    });
  });

  describe('a charge is never dropped', () => {
    it('a charge for no known subscription is recorded unverified in its own currency, with a case and a log entry', async () => {
      const eventId = `evt_${randomUUID()}`;
      const res = await fireStripe('invoice.paid', { id: 'in_orphan', subscription: 'sub_unknown', amount_paid: 9900, currency: 'eur', billing_reason: 'subscription_cycle' }, eventId);
      expect(res.statusCode, res.body).toBe(200);
      const payment = await paymentOf('in_orphan');
      expect(payment).toMatchObject({ amount: 9900, currency: 'EUR', status: 'SUCCEEDED', verification: 'UNVERIFIED', subscriptionId: null, provider: 'stripe' });
      expect(payment.unapplied).toMatchObject({ status: 'OPEN', provider: 'stripe', amount: 9900, currency: 'EUR', metadata: { reasonCode: 'no_subscription' } });

      await drainBillingEventOutbox();
      const logged = await events({ paymentId: payment.id });
      expect(logged.map((e) => e.type).sort()).toEqual(['payment.not_applied', 'payment.recorded', 'payment.unapplied']);
      const notApplied = logged.find((e) => e.type === 'payment.not_applied')!;
      expect(notApplied).toMatchObject({ providerEventId: eventId, currency: 'EUR', amount: 9900 });
      expect(notApplied.data).toEqual({ reason: 'no_subscription', expected: null, providerPaymentId: 'in_orphan' });

      // Redelivered: one payment, one case, the same three log entries.
      expect((await fireStripe('invoice.paid', { id: 'in_orphan', subscription: 'sub_unknown', amount_paid: 9900, currency: 'eur' }, eventId)).statusCode).toBe(200);
      expect(await prisma.payment.count({ where: { applicationId: w.applicationId } })).toBe(1);
      expect(await prisma.unappliedPayment.count({ where: { applicationId: w.applicationId } })).toBe(1);
      await drainBillingEventOutbox();
      expect(await events({ paymentId: payment.id })).toHaveLength(3);
    });

    it('a charge that names no currency and matches nothing is in the reporting currency, not assumed to be dollars', async () => {
      const app2 = await prisma.application.findUniqueOrThrow({ where: { id: w.applicationId } });
      await prisma.application.update({
        where: { id: w.applicationId },
        // Both spellings: the field is being renamed to `reportingCurrency`.
        data: { billingConfig: { ...(app2.billingConfig as object), currency: 'INR', reportingCurrency: 'INR' } },
      });
      await applyBillingEvent(
        {
          type: 'payment.succeeded',
          providerEventId: 'evt_nocur',
          applicationId: w.applicationId,
          providerPaymentId: 'pay_nocur',
          providerSubscriptionId: 'sub_unknown',
          amount: 5000,
          currency: null,
          description: null,
          firstPeriod: false,
          raw: {},
        },
        ctx(),
      );
      expect(await paymentOf('pay_nocur')).toMatchObject({ currency: 'INR', verification: 'UNVERIFIED' });
    });

    it('a renewal in another currency is unverified and unapplied: no period advance, no credits, no recovery', async () => {
      const { subscriptionId, providerSubId } = await paidSubscription();
      await prisma.subscription.update({ where: { id: subscriptionId }, data: { status: 'PAST_DUE' } });
      const before = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });

      const res = await fireStripe('invoice.paid', { id: 'in_inr', subscription: providerSubId, amount_paid: 149900, currency: 'inr', billing_reason: 'subscription_cycle' });
      expect(res.statusCode, res.body).toBe(200);
      const payment = await paymentOf('in_inr');
      expect(payment).toMatchObject({ amount: 149900, currency: 'INR', verification: 'UNVERIFIED', subscriptionId: null, endUserId: w.buyer.id, planPriceId: null });
      expect(payment.unapplied).toMatchObject({ status: 'OPEN', metadata: { reasonCode: 'currency_mismatch' } });
      // The subscription was not touched: a mismatched charge recovers nothing.
      const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
      expect(after).toMatchObject({ status: 'PAST_DUE', currency: 'USD', unitAmount: 2000, currentPeriodEnd: before.currentPeriodEnd });
      const notApplied = (await events({ type: 'payment.not_applied' }))[0]!;
      expect(notApplied).toMatchObject({ paymentId: payment.id, subscriptionId });
      expect(notApplied.data).toMatchObject({ reason: 'currency_mismatch', expected: { currency: 'USD', amount: 2000 } });
      const receipt = await prisma.webhookEvent.findFirstOrThrow({ where: { applicationId: w.applicationId }, orderBy: { receivedAt: 'desc' } });
      expect(receipt.processingError).toContain('"in_inr" is in INR');

      // Stripe reports the same invoice again under another event: the
      // payment on file was not applied, so the replay grants nothing either.
      const provision = vi.spyOn(entitlementsService, 'provision');
      const recover = vi.spyOn(dunningService, 'recoverForSubscription');
      const again = await fireStripe('invoice.payment_succeeded', { id: 'in_inr', subscription: providerSubId, amount_paid: 149900, currency: 'inr', billing_reason: 'subscription_cycle' });
      expect(again.statusCode, again.body).toBe(200);
      expect(provision).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      expect(await prisma.payment.count({ where: { applicationId: w.applicationId, providerPaymentId: 'in_inr' } })).toBe(1);
    });

    it('out of order: a payment that arrived before its subscription stays unapplied when it is delivered again', async () => {
      const { row } = await w.sessionOf(await w.checkout());
      const providerSubId = `sub_${randomUUID().slice(0, 8)}`;
      const invoice = { id: 'in_early', subscription: providerSubId, amount_paid: 2000, currency: 'usd', billing_reason: 'subscription_cycle' };
      // The renewal invoice lands first: nothing local names this provider subscription yet.
      expect((await fireStripe('invoice.paid', invoice)).statusCode).toBe(200);
      expect(await paymentOf('in_early')).toMatchObject({ verification: 'UNVERIFIED', subscriptionId: null, unapplied: { status: 'OPEN' } });

      const done = await fireStripe('checkout.session.completed', { id: row.providerSessionId, mode: 'subscription', subscription: providerSubId });
      expect(done.statusCode, done.body).toBe(200);

      // Delivered again, it now matches the subscription. The payment on file
      // was not applied and has an open case, so nothing is granted twice over:
      // the operator resolves the case.
      const provision = vi.spyOn(entitlementsService, 'provision');
      const recover = vi.spyOn(dunningService, 'recoverForSubscription');
      expect((await fireStripe('invoice.payment_succeeded', invoice)).statusCode).toBe(200);
      expect(provision).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      expect(await paymentOf('in_early')).toMatchObject({ verification: 'UNVERIFIED', subscriptionId: null, unapplied: { status: 'OPEN' } });
      expect(await prisma.payment.count({ where: { applicationId: w.applicationId } })).toBe(1);
    });

    it('a one-time charge that is not the amount its checkout was opened at grants nothing', async () => {
      await w.createPlan({ slug: 'pack', name: 'Pack', kind: 'CREDIT', price: { currency: 'USD', amount: 5000 }, creditsAmount: 100 });
      const { row } = await w.sessionOf(await w.checkout({ planSlug: 'pack' }));
      expect(row).toMatchObject({ kind: 'ONE_TIME', chargeAmount: 5000, currency: 'USD' });

      const short = await fireStripe('checkout.session.completed', {
        id: row.providerSessionId,
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_short',
        amount_total: 50,
        currency: 'usd',
      });
      expect(short.statusCode, short.body).toBe(200);
      expect(await paymentOf('pi_short')).toMatchObject({ amount: 50, verification: 'UNVERIFIED', subscriptionId: null, unapplied: { status: 'OPEN', metadata: { reasonCode: 'amount_out_of_band' } } });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: row.subscriptionId } })).status).toBe('PENDING');
      expect((await prisma.checkoutSession.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('OPEN');
      expect(await prisma.creditLedger.count({ where: { applicationId: w.applicationId } })).toBe(0);

      // The same checkout paid in full is applied, and its credits name the payment and the price.
      const full = await fireStripe('checkout.session.completed', {
        id: row.providerSessionId,
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_full',
        amount_total: 5000,
        currency: 'usd',
      });
      expect(full.statusCode, full.body).toBe(200);
      const payment = await paymentOf('pi_full');
      expect(payment).toMatchObject({ amount: 5000, verification: 'VERIFIED', subscriptionId: row.subscriptionId, planPriceId: row.planPriceId, unitAmount: 5000 });
      expect(await prisma.creditLedger.findMany({ where: { applicationId: w.applicationId } })).toMatchObject([
        { delta: 100, reason: 'PURCHASE', paymentId: payment.id, planPriceId: row.planPriceId },
      ]);
      const granted = await events({ type: 'credits.granted' });
      expect(granted).toHaveLength(1);
      expect(granted[0]).toMatchObject({ paymentId: payment.id, planPriceId: row.planPriceId, subscriptionId: row.subscriptionId });
      expect(granted[0]!.data).toEqual({ credits: 100, source: 'purchase', balanceAfter: 100 });
    });

    it('an amount the payments table cannot hold is noted on the receipt and answered 200, not retried forever', async () => {
      const note = vi.fn();
      await applyBillingEvent(
        {
          type: 'payment.succeeded',
          providerEventId: 'evt_big',
          applicationId: w.applicationId,
          providerPaymentId: 'pay_big',
          providerSubscriptionId: null,
          amount: 2_147_483_648,
          currency: 'usd',
          description: null,
          firstPeriod: false,
          raw: {},
        },
        { ...ctx(), note },
      );
      expect(await prisma.payment.count({ where: { applicationId: w.applicationId } })).toBe(0);
      expect(note.mock.calls[0]![0]).toContain('"pay_big" carried an amount Rekey cannot store');
    });
  });

  describe('PayPal renewals name the plan they bill', () => {
    it('reads the plan of the agreement and puts it on the payment event; a failed read drops only the id', async () => {
      const application = await prisma.application.findUniqueOrThrow({ where: { id: w.applicationId } });
      const translated = paypalModule.webhook.translate(
        {
          id: 'WH-SALE',
          event_type: 'PAYMENT.SALE.COMPLETED',
          resource: { id: 'SALE-1', billing_agreement_id: 'I-AGREEMENT', amount: { total: '20.00', currency: 'USD' } },
        },
        translateCtx({ applicationId: w.applicationId }),
      ) as DomainBillingEvent[];
      expect(translated.map((e) => e.type)).toEqual(['subscription.period_advanced', 'payment.succeeded']);
      expect(paypalModule.webhook.renewalPriceFromSubscription).toBe(true);

      fakePaypal.subscriptions.set('I-AGREEMENT', { id: 'I-AGREEMENT', status: 'ACTIVE', planId: 'P-REGISTERED', customId: null });
      const named = await withRenewalPriceIds(translated, application, 'paypal', quiet);
      expect(named[1]).toMatchObject({ type: 'payment.succeeded', providerPriceId: 'P-REGISTERED', amount: 2000, currency: 'USD' });
      expect(named[0]).toEqual(translated[0]);

      vi.spyOn(fakePaypal, 'getSubscription').mockRejectedValue(new Error('paypal is down'));
      const degraded = await withRenewalPriceIds(translated, application, 'paypal', quiet);
      expect(degraded[1]).toMatchObject({ type: 'payment.succeeded', amount: 2000 });
      expect(degraded[1]).not.toHaveProperty('providerPriceId');
    });
  });
});
