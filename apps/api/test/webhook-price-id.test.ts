/**
 * A renewal must bill the provider price the subscription is on.
 *
 * Stripe invoices and Razorpay charged subscriptions name the provider's own
 * price id. When the subscription's price has a registered id for that
 * provider and the two differ, the payment is refused the way a currency
 * mismatch is. An event with no id, and a price never registered, compare
 * nothing.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { STRIPE_API_VERSION } from '../src/modules/billing/providers/stripe-api-version.js';
import { invoicePriceId } from '../src/modules/billing/providers/modules/stripe/payload-shapes.js';
import { stripeModule } from '../src/modules/billing/providers/modules/stripe/index.js';
import { razorpayModule } from '../src/modules/billing/providers/modules/razorpay/index.js';
import type { DomainBillingEvent, TranslateCtx } from '../src/modules/billing/providers/module-types.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { revisePlan } from './seed-plan.js';

operatorsConfirmTheirEmail();

const stripe = new Stripe('sk_for_signing_only', { apiVersion: STRIPE_API_VERSION });

function translateCtx(): TranslateCtx {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger,
    applicationId: 'app_1',
    providerEventId: 'evt_1',
  } as never;
}

describe('the provider price id on a normalised payment', () => {
  const invoice = (lines: unknown[]) => ({ lines: { data: lines } }) as unknown as Stripe.Invoice;

  it('reads the price of a Stripe invoice in both API shapes', () => {
    expect(invoicePriceId(invoice([{ pricing: { price_details: { price: 'price_basil' } } }]))).toBe('price_basil');
    expect(invoicePriceId(invoice([{ price: { id: 'price_acacia' }, plan: { id: 'price_acacia' } }]))).toBe('price_acacia');
    // Two lines of one subscription item name the same price once.
    expect(
      invoicePriceId(invoice([{ pricing: { price_details: { price: 'price_a' } } }, { price: { id: 'price_a' } }])),
    ).toBe('price_a');
  });

  it('names no price for an invoice that bills two, or none', () => {
    expect(invoicePriceId(invoice([{ price: { id: 'price_old' } }, { price: { id: 'price_new' } }]))).toBeNull();
    expect(invoicePriceId(invoice([{ amount: 500 }]))).toBeNull();
    expect(invoicePriceId({} as Stripe.Invoice)).toBeNull();
  });

  it('Stripe invoice.paid carries it, and omits it when the invoice names none', async () => {
    const event = (object: Record<string, unknown>) =>
      stripeModule.webhook.translate(
        {
          id: 'evt_1',
          type: 'invoice.paid',
          created: Math.floor(Date.now() / 1000),
          data: { object: { id: 'in_1', metadata: { applicationId: 'app_1' }, amount_paid: 2000, currency: 'usd', ...object } },
        },
        translateCtx(),
      ) as Promise<DomainBillingEvent[]> | DomainBillingEvent[];
    const withLines = await event({ lines: { data: [{ pricing: { price_details: { price: 'price_1' } } }] } });
    expect(withLines[0]).toMatchObject({ type: 'payment.succeeded', providerPriceId: 'price_1' });
    const without = await event({});
    expect(without[0]).toMatchObject({ type: 'payment.succeeded' });
    expect(without[0]).not.toHaveProperty('providerPriceId');
  });

  it('Razorpay subscription.charged carries the plan id of the subscription entity', async () => {
    const event = (subscription: Record<string, unknown>) =>
      razorpayModule.webhook.translate(
        {
          event: 'subscription.charged',
          payload: {
            subscription: { entity: { id: 'sub_1', ...subscription } },
            payment: { entity: { id: 'pay_1', amount: 149900, currency: 'INR' } },
          },
        },
        translateCtx(),
      ) as DomainBillingEvent[];
    expect(event({ plan_id: 'plan_1' })[0]).toMatchObject({ type: 'payment.succeeded', providerPriceId: 'plan_1' });
    expect(event({})[0]).not.toHaveProperty('providerPriceId');
  });
});

describe('a renewal for another provider price', () => {
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

  const payments = () => prisma.payment.findMany({ where: { applicationId: w.applicationId }, orderBy: { createdAt: 'asc' } });
  const lastReceipt = () =>
    prisma.webhookEvent.findFirstOrThrow({ where: { applicationId: w.applicationId }, orderBy: { receivedAt: 'desc' } });

  describe('Razorpay, on an additional price', () => {
    let subscriptionId: string;
    let providerSubId: string;

    beforeEach(async () => {
      const { row, provider } = await w.sessionOf(await w.checkout({ country: 'IN' }));
      expect(provider).toBe('razorpay');
      providerSubId = row.providerSessionId;
      subscriptionId = row.subscriptionId;
      await w.razorpayWebhook({
        event: 'subscription.activated',
        payload: { subscription: { entity: { id: providerSubId, status: 'active' } } },
      });
      expect(await prisma.planPrice.findUniqueOrThrow({ where: { id: w.inrPriceId } })).toMatchObject({
        metadata: { razorpay: { planId: 'plan_stub_pro' } },
      });
    });

    const charged = (paymentId: string, subscription: Record<string, unknown> = {}) =>
      w.razorpayWebhook({
        event: 'subscription.charged',
        payload: {
          subscription: { entity: { id: providerSubId, status: 'active', paid_count: 2, ...subscription } },
          payment: { entity: { id: paymentId, amount: 149900, currency: 'INR' } },
        },
      });

    it('records a charge for the plan the price is registered as', async () => {
      expect((await charged('pay_ok', { plan_id: 'plan_stub_pro' })).statusCode).toBe(200);
      expect(await payments()).toMatchObject([{ providerPaymentId: 'pay_ok', subscriptionId, status: 'SUCCEEDED' }]);
      expect((await lastReceipt()).processingError).toBeNull();
    });

    it('records a charge for another plan, since the money was taken, and names both ids on the receipt', async () => {
      const res = await charged('pay_other', { plan_id: 'plan_someone_elses' });
      expect(res.statusCode, res.body).toBe(200);
      expect(await payments()).toMatchObject([{ providerPaymentId: 'pay_other' }]);
      const receipt = await lastReceipt();
      expect(receipt.processingError).toContain('plan_someone_elses');
      expect(receipt.processingError).toContain('plan_stub_pro');
    });

    it('compares nothing when the price was never registered with the provider', async () => {
      await prisma.planPrice.update({ where: { id: w.inrPriceId }, data: { metadata: {} } });
      await charged('pay_unregistered', { plan_id: 'plan_someone_elses' });
      expect(await payments()).toMatchObject([{ providerPaymentId: 'pay_unregistered' }]);
    });

    it("reads the additional price's registration, not the plan's", async () => {
      // The plan's own registration belongs to the default USD price.
      await revisePlan({ id: w.planId }, { metadata: { razorpay: { planId: 'plan_of_the_default_price' } } });
      await charged('pay_additional', { plan_id: 'plan_stub_pro' });
      expect(await payments()).toMatchObject([{ providerPaymentId: 'pay_additional' }]);
      expect((await lastReceipt()).processingError ?? '').not.toContain('plan_of_the_default_price');
      // A charge on the DEFAULT price's plan is the mismatch for this subscriber.
      await charged('pay_default', { plan_id: 'plan_of_the_default_price' });
      expect(await payments()).toHaveLength(2);
      expect((await lastReceipt()).processingError).toContain('plan_of_the_default_price');
    });
  });

  describe('Stripe, on the default price', () => {
    let providerSubId: string;
    let registered: string;

    function fireStripe(type: string, object: Record<string, unknown>) {
      const payload = JSON.stringify({
        id: `evt_${randomUUID()}`,
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
    const invoicePaid = (id: string, lines: unknown[]) =>
      fireStripe('invoice.paid', {
        id,
        subscription: providerSubId,
        amount_paid: 2000,
        currency: 'usd',
        billing_reason: 'subscription_cycle',
        lines: { data: lines },
      });

    beforeEach(async () => {
      const { row, provider } = await w.sessionOf(await w.checkout());
      expect(provider).toBe('stripe');
      providerSubId = `sub_${randomUUID().slice(0, 8)}`;
      const done = await fireStripe('checkout.session.completed', {
        id: row.providerSessionId,
        mode: 'subscription',
        subscription: providerSubId,
      });
      expect(done.statusCode, done.body).toBe(200);
      const plan = await prisma.plan.findUniqueOrThrow({ where: { id: w.planId } });
      registered = (plan.metadata as { stripe: { priceId: string } }).stripe.priceId;
      expect(registered).toMatch(/^price_/);
    });

    it('records an invoice for the registered price, and flags one for another without dropping it', async () => {
      const ok = await invoicePaid('in_ok', [{ pricing: { price_details: { price: registered } } }]);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await payments()).toMatchObject([{ providerPaymentId: 'in_ok', amount: 2000, currency: 'USD' }]);

      const other = await invoicePaid('in_other', [{ pricing: { price_details: { price: 'price_cheaper' } } }]);
      expect(other.statusCode, other.body).toBe(200);
      expect(await payments()).toHaveLength(2);
      const receipt = await lastReceipt();
      expect(receipt.processingError).toContain('price_cheaper');
      expect(receipt.processingError).toContain(registered);
    });
  });
});
