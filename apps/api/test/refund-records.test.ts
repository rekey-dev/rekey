/**
 * Refunds, from the provider's event to the rows it leaves: how Stripe and
 * PayPal refund events are read (ids, amounts, currency scale), what a refund
 * from a provider writes under redelivery, reordering and concurrency, and
 * what a refund an operator issues sends to the provider and records.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { STRIPE_API_VERSION } from '../src/modules/billing/providers/stripe-api-version.js';
import { stripeModule } from '../src/modules/billing/providers/modules/stripe/index.js';
import { paypalModule } from '../src/modules/billing/providers/modules/paypal/index.js';
import { refundedCaptureId } from '../src/modules/billing/providers/modules/paypal/enrich.js';
import type { DomainBillingEvent, TranslateCtx } from '../src/modules/billing/providers/module-types.js';
import type { RefundPaymentInput, RefundPaymentResult } from '../src/modules/billing/providers/types.js';
import { applyBillingEvent } from '../src/modules/billing/webhooks/apply.js';
import { fakeStripe } from './fakes/billing-providers.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

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

describe('refund records', () => {
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
