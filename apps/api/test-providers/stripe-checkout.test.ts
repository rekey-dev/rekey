/**
 * Checkout against a real Stripe test account — the session as STRIPE
 * understands it, not as we hoped it would.
 *
 * Every assertion here reads the Session back out of the Stripe API after
 * creating it. That is the whole design: `createCheckoutSession` builds a
 * parameter object and the mock accepted every one of them without opinion, so
 * a parameter we spelled wrong, a field Stripe ignored, or a discount that did
 * not land on the total was invisible. Reading it back is the only way to see
 * what the provider did with what we sent.
 *
 * Coupons get the most attention, because that is where a divergence costs
 * money in the direction nobody notices: Rekey records a discount and burns a
 * redemption locally, and if Stripe did not apply it the buyer simply paid
 * full price. `amount_total` and `total_details.amount_discount` are the two
 * numbers that settle it.
 *
 * Completing a session is a separate matter — see `stripe-checkout-browser.test.ts`.
 * There is no API in Stripe test mode that completes a hosted Checkout Session;
 * the supported route is a test card on the hosted page.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { couponsService } from '../src/modules/coupons/coupons.service.js';
import { plansService } from '../src/modules/plans/plans.service.js';
import { describeSandbox, stripeSandbox } from './support/credentials.js';
import { StripeJanitor, stripeClient } from './support/stripe-sandbox.js';
import { HARNESS_PREFIX, newRunId } from './support/naming.js';
import {
  configureStripe,
  createFixture,
  startCheckout,
  subscriptionBySession,
  type SandboxFixture,
} from './support/fixture.js';

describeSandbox('stripe', 'Stripe sandbox · checkout', stripeSandbox, (creds) => {
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

  /** An Application with real Stripe credentials and one registered plan. */
  async function withPlan(
    label: string,
    plan: { slug: string; amount: number; kind?: 'SUBSCRIPTION' | 'CREDIT' },
  ): Promise<{ fixture: SandboxFixture; planId: string; priceId: string | undefined }> {
    const fixture = await createFixture(label);
    await configureStripe(fixture, creds.apiKey);
    const created = await plansService.create({
      applicationId: fixture.applicationId,
      slug: plan.slug,
      name: `${HARNESS_PREFIX} ${plan.slug} ${runId}`,
      amount: plan.amount,
      currency: 'usd',
      interval: 'MONTH',
      ...(plan.kind === 'CREDIT' && { kind: 'CREDIT' as const, creditsAmount: 500 }),
    });
    const priceId = (created.metadata as { stripe?: { priceId?: string } }).stripe?.priceId;
    if (priceId) {
      const price = await stripe.prices.retrieve(priceId);
      janitor.track('product', typeof price.product === 'string' ? price.product : price.product.id);
    }
    return { fixture, planId: created.id, priceId };
  }

  it('creates a subscription Session Stripe agrees with — mode, price, email, metadata', async () => {
    const { fixture, planId, priceId } = await withPlan('co-sub', { slug: 'sub', amount: 1500 });

    const res = await startCheckout(fixture, { planSlug: 'sub' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { url: string; subscription: { metadata: Record<string, unknown> } };
    expect(data.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    const sessionId = data.subscription.metadata.checkoutSessionId as string;
    janitor.track('checkoutSession', sessionId);

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items'],
    });

    expect(session.mode).toBe('subscription');
    expect(session.status).toBe('open');
    expect(session.amount_total).toBe(1500);
    expect(session.currency).toBe('usd');
    expect(session.customer_email).toContain(HARNESS_PREFIX);
    expect(session.line_items?.data[0]?.price?.id).toBe(priceId);
    expect(session.line_items?.data[0]?.quantity).toBe(1);

    // Pinning a consequence worth knowing about rather than a bug. We pass
    // `customer_email` and never a `customer`, so Stripe mints a BRAND-NEW
    // Customer for every checkout: a buyer who subscribes, cancels and
    // re-subscribes is two customers in the operator's Stripe account, with no
    // saved payment method carried across and no single place to see their
    // history. It also means a Checkout-created customer can never be attached
    // to a test clock, which is why the lifecycle suites create their own
    // subscription through the API instead of completing a session.
    expect(session.customer).toBeNull();

    // The routing metadata the webhook translator reads to find the
    // Application. If Stripe dropped or renamed any of these, every inbound
    // event for this session would answer "cannot route" and the buyer's
    // subscription would sit PENDING forever.
    expect(session.metadata?.applicationId).toBe(fixture.applicationId);
    expect(session.metadata?.endUserId).toBe(fixture.endUserId);
    expect(session.metadata?.planId).toBe(planId);

    expect(session.success_url).toBe('https://example.com/thanks');
    expect(session.cancel_url).toBe('https://example.com/cancelled');

    // And the local row Rekey wrote alongside it.
    const local = await subscriptionBySession(fixture.applicationId, sessionId);
    expect(local?.status).toBe('PENDING');
    expect(local?.provider).toBe('stripe');
  });

  it('applies a coupon to the real Stripe total, not just to our own books', async () => {
    const { fixture } = await withPlan('co-coupon', { slug: 'discounted', amount: 4000 });

    // 25% off 4000 = 1000. Rekey resolves the percentage itself and hands
    // Stripe money — see `createDiscount` on why a percentage must not be
    // forwarded as one.
    await couponsService.create({
      applicationId: fixture.applicationId,
      code: `${HARNESS_PREFIX}-25`,
      discountType: 'PERCENT',
      amountOff: 2500,
      currency: 'usd',
    });

    const res = await startCheckout(fixture, {
      planSlug: 'discounted',
      couponCode: `${HARNESS_PREFIX}-25`,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      discountAmount: number;
      subscription: { metadata: Record<string, unknown> };
    };
    expect(data.discountAmount).toBe(1000);

    const sessionId = data.subscription.metadata.checkoutSessionId as string;
    janitor.track('checkoutSession', sessionId);
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['discounts'] });

    // The two numbers that decide whether a buyer was actually discounted.
    expect(session.total_details?.amount_discount).toBe(1000);
    expect(session.amount_total).toBe(3000);

    // The ad-hoc Coupon minted for this checkout, read back from Stripe. Each
    // of these bounds a way an abandoned checkout could leave a live discount
    // behind, or a `duration` that cut every future invoice instead of the first.
    const couponRef = session.discounts?.[0]?.coupon;
    const couponId = typeof couponRef === 'string' ? couponRef : couponRef?.id;
    expect(couponId).toBeTruthy();
    janitor.track('coupon', couponId);

    const coupon = await stripe.coupons.retrieve(couponId!);
    expect(coupon.amount_off).toBe(1000);
    expect(coupon.currency).toBe('usd');
    expect(coupon.percent_off).toBeNull();
    expect(coupon.duration).toBe('once');
    expect(coupon.max_redemptions).toBe(1);
    expect(coupon.redeem_by).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(coupon.metadata?.rekeyCouponCode).toBe(`${HARNESS_PREFIX}-25`);
  });

  it('a one-time (CREDIT) purchase is a `payment` Session with an inline price', async () => {
    const { fixture } = await withPlan('co-onetime', {
      slug: 'credits',
      amount: 2000,
      kind: 'CREDIT',
    });

    const res = await startCheckout(fixture, { planSlug: 'credits' });
    expect(res.statusCode).toBe(200);
    const sessionId = (res.json().data.subscription.metadata as Record<string, unknown>)
      .checkoutSessionId as string;
    janitor.track('checkoutSession', sessionId);

    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
    expect(session.mode).toBe('payment');
    expect(session.amount_total).toBe(2000);
    // Inline `price_data`, so Stripe minted a price for this session alone —
    // it must NOT be the recurring plan price.
    expect(session.line_items?.data[0]?.price?.recurring).toBeNull();
    const productRef = session.line_items?.data[0]?.price?.product;
    janitor.track('product', typeof productRef === 'string' ? productRef : productRef?.id);
  });

  it('refuses a full-price one-time coupon before Stripe is ever called', async () => {
    const { fixture } = await withPlan('co-full', {
      slug: 'comped',
      amount: 1200,
      kind: 'CREDIT',
    });
    await couponsService.create({
      applicationId: fixture.applicationId,
      code: `${HARNESS_PREFIX}-full`,
      discountType: 'AMOUNT',
      amountOff: 1200,
      currency: 'usd',
    });

    const before = await stripe.coupons.list({ limit: 5 });
    const res = await startCheckout(fixture, {
      planSlug: 'comped',
      couponCode: `${HARNESS_PREFIX}-full`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('COUPON_FULL_DISCOUNT_UNSUPPORTED');

    // The refusal happens in `checkout-discount.ts`, before a provider is
    // built — so no Coupon object was minted and abandoned in the operator's
    // Stripe account. Asserted against Stripe rather than against a spy.
    const after = await stripe.coupons.list({ limit: 5 });
    expect(after.data[0]?.id).toBe(before.data[0]?.id);
  });
});
