/**
 * Webhook → subscription → entitlement, driven by events Stripe genuinely
 * emitted.
 *
 * Every event fed to the pipeline in this file was fetched from
 * `stripe.events.list` after a real billing action — the same object, field
 * for field, that Stripe would have POSTed to a public endpoint. The one thing
 * that is local is the signature; see the header of `support/fixture.ts` for
 * exactly what that does and does not prove.
 *
 * The assertions worth reading twice are the ones about **what the payload
 * contains**, because those are the assumptions the translator is built on and
 * a hand-written fixture can only ever confirm:
 *
 *   - `invoice.metadata.applicationId` — the ONLY thing that routes an
 *     invoice event to an Application. `stripe-real.ts` sets metadata on the
 *     subscription and comments that it "propagates to the resulting
 *     subscription/invoice events automatically". If that inheritance is not
 *     real, every `invoice.paid` is dropped with "cannot route" and no payment
 *     is ever recorded — while the money moved.
 *
 *   - `invoice.subscription` — read as a string by the translator. Stripe
 *     moved this field under `parent` in the 2025 API versions, and an EVENT
 *     is rendered in the ACCOUNT's default API version, not the one the SDK
 *     client asks for. `registerWebhook` does not pin `api_version` on the
 *     endpoints it creates, so a sandbox (or a production account) on a newer
 *     default renders payloads our translator cannot read. The version is
 *     asserted here so that failure is diagnosed rather than mysterious.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { prisma } from '../src/lib/prisma.js';
import { plansService } from '../src/modules/plans/plans.service.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';
import { describeSandbox, stripeSandbox } from './support/credentials.js';
import { StripeJanitor, stripeClient } from './support/stripe-sandbox.js';
import { HARNESS_PREFIX, newRunId } from './support/naming.js';
import {
  configureStripe,
  createFixture,
  deliverStripeEvent,
  readEntitlements,
  startCheckout,
  subscriptionBySession,
  waitForStripeEvents,
  type SandboxFixture,
} from './support/fixture.js';
import { createLiveSubscription, linkProviderSubscription } from './support/stripe-lifecycle.js';

/** The API version `RealStripeProvider` and the translator are written against. */
const PINNED_API_VERSION = '2024-11-20.acacia';

describeSandbox('stripe', 'Stripe sandbox · webhook → subscription → entitlement', stripeSandbox, (creds) => {
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

  /**
   * A buyer mid-checkout: real plan, real Stripe Price, real Checkout Session,
   * a local PENDING Subscription — and a live Stripe subscription standing in
   * for the one a completed checkout would have created.
   */
  async function buyerAtActivation(label: string): Promise<{
    fixture: SandboxFixture;
    planId: string;
    priceId: string;
    localSubscriptionId: string;
    providerSubscriptionId: string;
    since: number;
  }> {
    const fixture = await createFixture(label);
    await configureStripe(fixture, creds.apiKey);

    const plan = await plansService.create({
      applicationId: fixture.applicationId,
      slug: 'team',
      name: `${HARNESS_PREFIX} Team ${runId}`,
      amount: 3000,
      currency: 'usd',
      interval: 'MONTH',
    });
    const priceId = (plan.metadata as { stripe?: { priceId?: string } }).stripe?.priceId!;
    const price = await stripe.prices.retrieve(priceId);
    janitor.track('product', typeof price.product === 'string' ? price.product : price.product.id);

    // Two entitlements so both resolution paths are covered: a FEATURE that is
    // read at request time, and a quantity the provisioner materialises.
    await entitlementsService.upsert({
      planId: plan.id,
      kind: 'FEATURE',
      key: 'priority_support',
      valueType: 'BOOL',
      value: 'true',
    });
    await entitlementsService.upsert({
      planId: plan.id,
      kind: 'FEATURE',
      key: 'seats',
      valueType: 'INT',
      value: '10',
    });

    const checkout = await startCheckout(fixture, { planSlug: 'team' });
    expect(checkout.statusCode).toBe(200);
    const sessionId = (checkout.json().data.subscription.metadata as Record<string, unknown>)
      .checkoutSessionId as string;
    janitor.track('checkoutSession', sessionId);
    const local = await subscriptionBySession(fixture.applicationId, sessionId);
    expect(local?.status).toBe('PENDING');

    const since = Math.floor(Date.now() / 1000) - 5;
    const live = await createLiveSubscription(stripe, janitor, {
      runId,
      priceId,
      metadata: {
        applicationId: fixture.applicationId,
        endUserId: fixture.endUserId,
        planId: plan.id,
      },
    });
    await linkProviderSubscription(local!.id, live.subscription.id);

    return {
      fixture,
      planId: plan.id,
      priceId,
      localSubscriptionId: local!.id,
      providerSubscriptionId: live.subscription.id,
      since,
    };
  }

  it('activates the subscription, records the payment and provisions entitlements', async () => {
    const buyer = await buyerAtActivation('wh-activate');

    const events = await waitForStripeEvents(stripe, {
      types: ['invoice.paid', 'customer.subscription.updated'],
      since: buyer.since,
      expect: 1,
      match: (e) => {
        const object = e.data.object as { subscription?: unknown; id?: string };
        return (
          object.subscription === buyer.providerSubscriptionId ||
          object.id === buyer.providerSubscriptionId
        );
      },
    });
    expect(events.length).toBeGreaterThan(0);

    const invoicePaid = events.find((e) => e.type === 'invoice.paid');
    expect(invoicePaid, 'Stripe emitted no invoice.paid for a subscription it charged').toBeTruthy();

    // --- The two payload assumptions the translator is built on -------------
    // Both are assertions about STRIPE, not about us, and both are the kind
    // that a fixture written from our own reading of the docs would have
    // confirmed whether or not they were true.
    expect(
      invoicePaid!.api_version,
      'Stripe renders events in the ACCOUNT default API version, not the SDK client version. ' +
        `This account renders ${invoicePaid!.api_version}; the translator is written for ` +
        `${PINNED_API_VERSION}. registerWebhook does not pin api_version on the endpoints it ` +
        'creates, so production has the same exposure.',
    ).toBe(PINNED_API_VERSION);

    const invoice = invoicePaid!.data.object as Stripe.Invoice;
    expect(
      invoice.metadata?.applicationId,
      'invoice.metadata.applicationId is the only field that routes an invoice event to an ' +
        'Application. stripe-real.ts relies on subscription metadata propagating onto the ' +
        'invoice; if it does not, every invoice.paid is dropped as unroutable.',
    ).toBe(buyer.fixture.applicationId);
    expect(typeof invoice.subscription).toBe('string');

    // --- Now put it through the pipeline, signed ---------------------------
    const res = await deliverStripeEvent(buyer.fixture, invoicePaid!);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ received: true, processed: true });

    const row = await prisma.subscription.findUniqueOrThrow({
      where: { id: buyer.localSubscriptionId },
    });
    expect(row.status).toBe('ACTIVE');

    const payment = await prisma.payment.findFirstOrThrow({
      where: { applicationId: buyer.fixture.applicationId },
    });
    expect(payment.status).toBe('SUCCEEDED');
    // The amount Stripe actually collected, matched against the plan. This is
    // where a units mismatch would surface — `resolveChargeCurrency` drops a
    // payment whose currency disagrees with the plan, so a silent 0-payment
    // row here would mean the cross-check rejected a genuine charge.
    expect(payment.amount).toBe(3000);
    expect(payment.currency.toLowerCase()).toBe('usd');
    expect(payment.subscriptionId).toBe(buyer.localSubscriptionId);

    const entitlements = await readEntitlements(buyer.fixture);
    expect(entitlements.features.priority_support).toBe(true);
    expect(entitlements.features.seats).toBe(10);
  });

  it('rejects a tampered body with 401 and applies nothing', async () => {
    const buyer = await buyerAtActivation('wh-tamper');
    const events = await waitForStripeEvents(stripe, {
      types: ['invoice.paid'],
      since: buyer.since,
      expect: 1,
      match: (e) => (e.data.object as { subscription?: unknown }).subscription === buyer.providerSubscriptionId,
    });
    expect(events).toHaveLength(1);

    const res = await deliverStripeEvent(buyer.fixture, events[0]!, { tamper: true });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });

    const row = await prisma.subscription.findUniqueOrThrow({
      where: { id: buyer.localSubscriptionId },
    });
    expect(row.status).toBe('PENDING');
    expect(await prisma.payment.count({ where: { applicationId: buyer.fixture.applicationId } })).toBe(0);
  });

  it('acks a re-delivery as a duplicate without recording the money twice', async () => {
    const buyer = await buyerAtActivation('wh-replay');
    const events = await waitForStripeEvents(stripe, {
      types: ['invoice.paid'],
      since: buyer.since,
      expect: 1,
      match: (e) => (e.data.object as { subscription?: unknown }).subscription === buyer.providerSubscriptionId,
    });
    expect(events).toHaveLength(1);

    const first = await deliverStripeEvent(buyer.fixture, events[0]!);
    expect(first.body).toMatchObject({ processed: true });
    const second = await deliverStripeEvent(buyer.fixture, events[0]!);
    // 200 so Stripe stops retrying, and explicitly NOT re-applied.
    expect(second.statusCode).toBe(200);
    expect(second.body).toMatchObject({ processed: false, reason: 'duplicate' });

    expect(await prisma.payment.count({ where: { applicationId: buyer.fixture.applicationId } })).toBe(1);
  });
});
