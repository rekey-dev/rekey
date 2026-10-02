/**
 * Refunding a subscription payment Rekey recorded under its invoice id.
 *
 * Renewals are stored as `in_...`, and from `2025-03-31.basil` an Invoice no
 * longer names its payment intent. `RealStripeProvider.refundPayment` resolves
 * the invoice through Invoice Payments; this runs that against a real sandbox
 * invoice, so the list filter, the payment shape and the refund it produces
 * are Stripe's, not a stub's.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { RealStripeProvider } from '../src/modules/billing/providers/stripe-real.js';
import { describeSandbox, stripeSandbox } from './support/credentials.js';
import { StripeJanitor, stripeClient } from './support/stripe-sandbox.js';
import { HARNESS_METADATA, HARNESS_PREFIX, newRunId } from './support/naming.js';
import { createLiveSubscription } from './support/stripe-lifecycle.js';

describeSandbox('stripe', 'Stripe sandbox · renewal invoice refund', stripeSandbox, (creds) => {
  let stripe: Stripe;
  let janitor: StripeJanitor;
  let runId: string;

  beforeAll(() => {
    stripe = stripeClient(creds.apiKey);
    janitor = new StripeJanitor(stripe);
    runId = newRunId();
  });

  afterAll(async () => {
    await janitor.cleanup();
  });

  it('refunds an in_ payment through the payment intent Invoice Payments names', async () => {
    const product = await stripe.products.create({
      name: `${HARNESS_PREFIX} Refundable ${runId}`,
      metadata: { ...HARNESS_METADATA },
    });
    janitor.track('product', product.id);
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 1500,
      currency: 'usd',
      recurring: { interval: 'month' },
    });

    const live = await createLiveSubscription(stripe, janitor, {
      runId,
      priceId: price.id,
      metadata: { applicationId: 'app_sandbox_refund', endUserId: 'eu_sandbox', planId: 'pl_sandbox' },
    });
    const invoice = live.subscription.latest_invoice;
    const invoiceId = typeof invoice === 'string' ? invoice : invoice?.id;
    expect(invoiceId, 'the subscription has no first invoice').toMatch(/^in_/);

    const payments = await stripe.invoicePayments.list({ invoice: invoiceId!, status: 'paid' });
    const intent = payments.data[0]?.payment.payment_intent;
    const intentId = typeof intent === 'string' ? intent : intent?.id;
    expect(intentId, 'Stripe reports no paid payment intent on the invoice').toMatch(/^pi_/);

    const provider = new RealStripeProvider({ apiKey: creds.apiKey, webhookSecret: 'whsec_unused' });
    const result = await provider.refundPayment({
      providerPaymentId: invoiceId!,
      amount: 500,
      idempotencyKey: `${HARNESS_PREFIX}-${runId}-renewal-refund`,
    });
    expect(result).toMatchObject({ amount: 500, currency: 'USD' });

    const refund = await stripe.refunds.retrieve(result.refundId);
    const refunded = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id;
    expect(refunded).toBe(intentId);
  });
});
