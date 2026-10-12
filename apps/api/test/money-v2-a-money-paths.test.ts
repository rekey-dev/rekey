/**
 * Money model v2, step A: what the webhook appliers, refunds and checkout do
 * with money, asserted on the rows, the billing log and the wire.
 *
 *   - a charge is never dropped: unmatched, in another currency, out of band
 *     or for a foreign provider price, it is an UNVERIFIED payment with an
 *     unapplied case, and nothing is granted for it;
 *   - every refund is a row and a log entry, once, whatever order and however
 *     often its events arrive, and the payment total is the sum of its rows;
 *   - checkout, completion and payment leave their trail in the billing log.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { drainBillingEventOutbox } from '../src/modules/billing-log/index.js';
import { STRIPE_API_VERSION } from '../src/modules/billing/providers/stripe-api-version.js';
import { stripeModule } from '../src/modules/billing/providers/modules/stripe/index.js';
import { paypalModule } from '../src/modules/billing/providers/modules/paypal/index.js';
import { refundedCaptureId } from '../src/modules/billing/providers/modules/paypal/enrich.js';
import type { DomainBillingEvent, TranslateCtx } from '../src/modules/billing/providers/module-types.js';
import type { RefundPaymentInput, RefundPaymentResult } from '../src/modules/billing/providers/types.js';
import { applyBillingEvent } from '../src/modules/billing/webhooks/apply.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';
import { dunningService } from '../src/modules/billing/dunning.service.js';
import { withRenewalPriceIds } from '../src/modules/billing/webhooks/renewal-price-id.js';
import { fakePaypal, fakeStripe } from './fakes/billing-providers.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';

const stripe = new Stripe('sk_for_signing_only', { apiVersion: STRIPE_API_VERSION });
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

function translateCtx(extra: Partial<TranslateCtx> = {}): TranslateCtx {
  return { log: quiet, applicationId: 'app_1', providerEventId: 'evt_1', ...extra };
}

describe('refund events as the providers send them', () => {
  const chargeRefunded = (object: Record<string, unknown>) =>
    stripeModule.webhook.translate(
      {
        id: 'evt_refund',
        type: 'charge.refunded',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: { id: 'ch_1', invoice: 'in_1', amount: 2000, currency: 'usd', metadata: { applicationId: 'app_1' }, ...object },
        },
      },
      translateCtx(),
    ) as Promise<DomainBillingEvent[]>;

  it('Stripe: one charge.refunded that lists two refunds carries both ids and amounts', async () => {
    const [event] = await chargeRefunded({
      amount_refunded: 700,
      refunds: {
        data: [
          { id: 're_2', amount: 300, currency: 'usd', status: 'succeeded' },
          { id: 're_1', amount: 400, currency: 'usd', status: 'pending' },
        ],
      },
    });
    expect(event).toMatchObject({
      type: 'payment.refunded',
      refundedTotal: 700,
      refunds: [
        { providerRefundId: 're_2', amount: 300, status: 'succeeded' },
        { providerRefundId: 're_1', amount: 400, status: 'pending' },
      ],
    });
  });

  it('Stripe: refunds are read at the scale Stripe sends them, ISK as two decimals', async () => {
    const [event] = await chargeRefunded({
      currency: 'isk',
      amount: 500000,
      amount_refunded: 200000,
      refunds: { data: [{ id: 're_isk', amount: 200000, currency: 'isk', status: 'succeeded' }] },
    });
    expect(event).toMatchObject({ refundedTotal: 2000, refunds: [{ providerRefundId: 're_isk', amount: 2000 }] });
  });

  it('Stripe: a charge that lists no refunds carries the running total alone', async () => {
    const [event] = await chargeRefunded({ amount_refunded: 400 });
    expect(event).toMatchObject({ refundedTotal: 400 });
    expect(event).not.toHaveProperty('refunds');
  });

  it('PayPal: a capture refund names the capture by its up link and the refund by its own id', () => {
    const translated = paypalModule.webhook.translate(
      {
        id: 'WH-R1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: 'REFUND-9',
          status: 'COMPLETED',
          amount: { value: '12.50', currency_code: 'USD' },
          links: [
            { rel: 'self', href: 'https://api-m.paypal.com/v2/payments/refunds/REFUND-9' },
            { rel: 'up', href: 'https://api-m.paypal.com/v2/payments/captures/CAP-7' },
          ],
        },
      },
      translateCtx(),
    ) as DomainBillingEvent[];
    expect(translated[0]).toMatchObject({
      type: 'payment.refunded',
      providerPaymentId: 'CAP-7',
      providerRefundId: 'REFUND-9',
      refundStatus: 'succeeded',
      amount: 1250,
      currency: 'USD',
    });
    expect(refundedCaptureId({ links: [{ rel: 'self', href: 'https://api-m.paypal.com/v2/payments/refunds/R' }] })).toBeNull();
  });

  it('PayPal: a HUF refund is read in whole units, 5000 as 500000 stored', () => {
    const translated = paypalModule.webhook.translate(
      {
        id: 'WH-R2',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: 'REFUND-HUF',
          amount: { value: '5000', currency_code: 'HUF' },
          links: [{ rel: 'up', href: 'https://api-m.paypal.com/v2/payments/captures/CAP-HUF' }],
        },
      },
      translateCtx(),
    ) as DomainBillingEvent[];
    expect(translated[0]).toMatchObject({ providerPaymentId: 'CAP-HUF', amount: 500000, currency: 'HUF' });
  });
});

describe('money paths', () => {
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

  const refundEvent = (providerPaymentId: string, extra: Record<string, unknown>, providerEventId = `evt_${randomUUID()}`) =>
    ({
      type: 'payment.refunded',
      providerEventId,
      applicationId: w.applicationId,
      providerPaymentId,
      providerSubscriptionId: null,
      amount: null,
      currency: 'usd',
      description: null,
      raw: {},
      ...extra,
    }) as DomainBillingEvent;

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

    it("the subscription a buyer reads carries the price they pay, not the plan's default", async () => {
      const { row } = await w.sessionOf(await w.checkout({ country: 'IN' }));
      await w.razorpayWebhook({ event: 'subscription.activated', payload: { subscription: { entity: { id: row.providerSessionId, status: 'active' } } } });
      const res = await w.asBuyer('GET', '/subscription');
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body).data.price).toEqual({ id: w.inrPriceId, currency: 'INR', amount: 149900, formatted: '₹1,499.00' });
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

  describe('refunds from a provider', () => {
    it('one event carrying two refunds writes two rows and two log entries, and a redelivery writes none', async () => {
      await paidSubscription('in_two');
      const event = refundEvent(
        'in_two',
        { refundedTotal: 700, refunds: [{ providerRefundId: 're_a', amount: 300, status: 'succeeded' }, { providerRefundId: 're_b', amount: 400, status: 'succeeded' }] },
        'evt_two_refunds',
      );
      await applyBillingEvent(event, ctx());
      await applyBillingEvent(event, ctx());

      const payment = await paymentOf('in_two');
      expect(payment).toMatchObject({ refundedAmount: 700, status: 'PARTIALLY_REFUNDED' });
      expect(payment.refunds).toMatchObject([
        { providerRefundId: 're_a', amount: 300, currency: 'USD', status: 'SUCCEEDED', initiatedBy: 'PROVIDER' },
        { providerRefundId: 're_b', amount: 400, currency: 'USD', status: 'SUCCEEDED', initiatedBy: 'PROVIDER' },
      ]);
      const logged = await events({ type: 'payment.refunded' });
      expect(logged.map((e) => [e.refundId, e.amount, (e.data as { totalRefunded: number }).totalRefunded])).toEqual([
        [payment.refunds[0]!.id, 300, 300],
        [payment.refunds[1]!.id, 400, 700],
      ]);
      expect(logged[0]).toMatchObject({ paymentId: payment.id, providerEventId: 'evt_two_refunds', currency: 'USD', actorType: 'PROVIDER' });
    });

    it('running totals out of order: the newer total first, then the older one changes nothing', async () => {
      await paidSubscription('in_order');
      await applyBillingEvent(refundEvent('in_order', { refundedTotal: 900 }), ctx());
      await applyBillingEvent(refundEvent('in_order', { refundedTotal: 400 }), ctx());
      const payment = await paymentOf('in_order');
      expect(payment.refundedAmount).toBe(900);
      expect(payment.refunds).toMatchObject([{ amount: 900, providerRefundId: null }]);
      // A later, larger total is one more refund for the difference.
      await applyBillingEvent(refundEvent('in_order', { refundedTotal: 2000 }), ctx());
      const full = await paymentOf('in_order');
      expect(full).toMatchObject({ refundedAmount: 2000, status: 'REFUNDED' });
      expect(full.refunds.map((r) => r.amount)).toEqual([900, 1100]);
    });

    it('listed refunds out of order, with a total larger than they add up to, leave one row for the rest', async () => {
      await paidSubscription('in_listed');
      await applyBillingEvent(refundEvent('in_listed', { refundedTotal: 1000, refunds: [{ providerRefundId: 're_2', amount: 300 }] }), ctx());
      let payment = await paymentOf('in_listed');
      expect(payment.refunds.map((r) => [r.providerRefundId, r.amount])).toEqual([['re_2', 300], [null, 700]]);
      // The earlier refund's own event arrives late and names it: the total is already explained.
      await applyBillingEvent(refundEvent('in_listed', { refundedTotal: 1000, refunds: [{ providerRefundId: 're_2', amount: 300 }] }), ctx());
      payment = await paymentOf('in_listed');
      expect(payment.refundedAmount).toBe(1000);
      expect(payment.refunds).toHaveLength(2);
    });

    it('a refund with no id is counted once per event id, and a refund past the payment is refused whole', async () => {
      await paidSubscription('in_amounts');
      const first = refundEvent('in_amounts', { amount: 500 }, 'evt_amount_1');
      await applyBillingEvent(first, ctx());
      await applyBillingEvent(first, ctx());
      expect((await paymentOf('in_amounts')).refundedAmount).toBe(500);

      const context = ctx();
      await applyBillingEvent(
        refundEvent('in_amounts', { refunds: [{ providerRefundId: 're_fits', amount: 1000 }, { providerRefundId: 're_over', amount: 1000 }] }),
        context,
      );
      const payment = await paymentOf('in_amounts');
      expect(payment.refundedAmount).toBe(500);
      expect(payment.refunds).toHaveLength(1);
      expect(context.note.mock.calls[0]![0]).toContain('BILLING_REFUND_EXCEEDS_PAYMENT');
    });

    it('a pending refund that later fails stops counting, and the payment is whole again', async () => {
      await paidSubscription('in_fail');
      await applyBillingEvent(refundEvent('in_fail', { providerRefundId: 're_slow', amount: 2000, refundStatus: 'pending' }), ctx());
      expect(await paymentOf('in_fail')).toMatchObject({ refundedAmount: 2000, status: 'REFUNDED' });
      await applyBillingEvent(refundEvent('in_fail', { providerRefundId: 're_slow', amount: 2000, refundStatus: 'failed' }), ctx());
      const payment = await paymentOf('in_fail');
      expect(payment).toMatchObject({ refundedAmount: 0, status: 'SUCCEEDED' });
      expect(payment.refunds).toMatchObject([{ providerRefundId: 're_slow', status: 'FAILED' }]);
    });

    it('eight concurrent deliveries of eight different refunds lose none and never pass the payment', async () => {
      await paidSubscription('in_race');
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          applyBillingEvent(refundEvent('in_race', { providerRefundId: `re_race_${i}`, amount: 300 }), ctx()),
        ),
      );
      const payment = await paymentOf('in_race');
      // 2000 holds six refunds of 300; the other two are refused.
      expect(payment.refunds).toHaveLength(6);
      expect(payment.refundedAmount).toBe(1800);
      expect(payment.refundedAmount).toBe(payment.refunds.reduce((sum, r) => sum + r.amount, 0));
      expect(await events({ type: 'payment.refunded' })).toHaveLength(6);
    });
  });

  describe('refunds an operator issues', () => {
    let issued: RefundPaymentInput[];

    /** A Stripe that honours its idempotency key, as the real one does. */
    function refundingStripe(): void {
      issued = [];
      const byKey = new Map<string, RefundPaymentResult>();
      (fakeStripe as { refundPayment?: (input: RefundPaymentInput) => Promise<RefundPaymentResult> }).refundPayment = async (input) => {
        issued.push(input);
        const known = byKey.get(input.idempotencyKey);
        if (known) return known;
        const result: RefundPaymentResult = { refundId: `re_${randomUUID().slice(0, 8)}`, amount: input.amount ?? 0, currency: 'USD', status: 'succeeded' };
        byKey.set(input.idempotencyKey, result);
        return result;
      };
    }

    const refund = (paymentId: string, body: Record<string, unknown> = {}) => w.operator('POST', `/payments/${paymentId}/refunds`, body);

    it('two partial refunds of one payment are two rows, on the wire and in the log, and the provider is sent the literal amounts', async () => {
      refundingStripe();
      await paidSubscription('in_partial');
      const payment = await paymentOf('in_partial');

      const first = await refund(payment.id, { amount: 500, reason: 'goodwill' });
      expect(first.statusCode, first.body).toBe(200);
      const firstBody = JSON.parse(first.body).data;
      expect(firstBody.refund).toMatchObject({ paymentId: payment.id, amount: 500, currency: 'USD', status: 'succeeded', initiatedBy: 'operator', reason: 'goodwill' });
      expect(firstBody.payment).toEqual({ id: payment.id, amount: 2000, currency: 'USD', refundedAmount: 500, status: 'PARTIALLY_REFUNDED' });

      const second = await refund(payment.id, { amount: 700 });
      expect(JSON.parse(second.body).data.payment).toMatchObject({ refundedAmount: 1200, status: 'PARTIALLY_REFUNDED' });
      expect(issued.map((i) => [i.providerPaymentId, i.amount, i.currency])).toEqual([['in_partial', 500, 'USD'], ['in_partial', 700, 'USD']]);
      expect(issued[0]!.idempotencyKey).not.toBe(issued[1]!.idempotencyKey);

      const listed = await w.operator('GET', `/payments/${payment.id}/refunds`);
      expect(JSON.parse(listed.body).data).toMatchObject({
        items: [{ amount: 500, initiatedBy: 'operator' }, { amount: 700, initiatedBy: 'operator' }],
        page: { total: 2, limit: 50, offset: 0, hasMore: false },
      });
      const logged = await events({ type: 'payment.refunded' });
      expect(logged.map((e) => [e.amount, e.actorType, (e.data as { totalRefunded: number }).totalRefunded])).toEqual([[500, 'OPERATOR', 500], [700, 'OPERATOR', 1200]]);

      // Stripe then reports the same two refunds: nothing is counted twice.
      const rows = (await paymentOf('in_partial')).refunds;
      await applyBillingEvent(
        refundEvent('in_partial', { refundedTotal: 1200, refunds: rows.map((r) => ({ providerRefundId: r.providerRefundId!, amount: r.amount })) }),
        ctx(),
      );
      expect(await paymentOf('in_partial')).toMatchObject({ refundedAmount: 1200, refunds: [{ initiatedBy: 'OPERATOR' }, { initiatedBy: 'OPERATOR' }] });
    });

    it('refuses more than what remains, and a payment that is not this Application\'s', async () => {
      refundingStripe();
      await paidSubscription('in_bounds');
      const payment = await paymentOf('in_bounds');
      const over = await refund(payment.id, { amount: 2001 });
      expect(over.statusCode).toBe(400);
      expect(JSON.parse(over.body).error.code).toBe('BILLING_REFUND_AMOUNT_EXCEEDED');
      expect(issued).toHaveLength(0);

      const other = await twoCurrencyWorld(app);
      const foreign = await other.operator('POST', `/payments/${payment.id}/refunds`, {});
      expect(foreign.statusCode).toBe(404);
      expect(JSON.parse(foreign.body).error.code).toBe('PAYMENT_NOT_FOUND');
      expect(issued).toHaveLength(0);
    });

    it('eight concurrent full refunds are one refund at the provider and one row', async () => {
      refundingStripe();
      await paidSubscription('in_full_race');
      const payment = await paymentOf('in_full_race');
      const responses = await Promise.all(Array.from({ length: 8 }, () => refund(payment.id, { amount: 2000 })));
      expect(responses.filter((r) => r.statusCode === 200).length).toBeGreaterThanOrEqual(1);
      expect(new Set(issued.map((i) => i.idempotencyKey)).size).toBe(1);
      const after = await paymentOf('in_full_race');
      expect(after).toMatchObject({ refundedAmount: 2000, status: 'REFUNDED' });
      expect(after.refunds).toHaveLength(1);
      expect(await events({ type: 'payment.refunded' })).toHaveLength(1);
    });
  });
});
