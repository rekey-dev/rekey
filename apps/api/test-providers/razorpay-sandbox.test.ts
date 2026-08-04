/**
 * Razorpay test mode — plan registration, checkout, and the cancellation shape
 * that was inverted on the wire.
 *
 * The cancellation test is the one that earns this file. `cancelSubscription`
 * passed razorpay-node's `cancelAtCycleEnd` argument NEGATED, so "cancel at
 * period end" terminated the subscription immediately at Razorpay while
 * Rekey's own row happily reported ACTIVE until the period end that would
 * never arrive. The fake provider in the ordinary suite records the call and
 * has no opinion about what Razorpay does with it; only asking Razorpay
 * settles it, which is what happens below.
 *
 * `test/razorpay-cancel-at-cycle-end.test.ts` pins the same thing at the wire
 * level so it stays covered on a machine with no keys. This is the half that
 * proves Razorpay agrees.
 *
 * Cleanup note: Razorpay plans cannot be deleted through the API. Everything
 * created here is named with the harness prefix and carries `rekey_harness` in
 * `notes`; subscriptions ARE cancelled. See docs/provider-sandbox-testing.md.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { plansService } from '../src/modules/plans/plans.service.js';
import { describeSandbox, razorpaySandbox } from './support/credentials.js';
import { HARNESS_PREFIX, newRunId } from './support/naming.js';
import {
  closeSandboxApp,
  configureProvider,
  createFixture,
  startCheckout,
  subscriptionBySession,
  type SandboxFixture,
} from './support/fixture.js';

interface RazorpayLike {
  subscriptions: {
    fetch(id: string): Promise<{ id: string; status: string; end_at?: number; ended_at?: number }>;
    cancel(id: string, atCycleEnd?: boolean): Promise<unknown>;
  };
}

describeSandbox('razorpay', 'Razorpay test mode', razorpaySandbox, (creds) => {
  let runId: string;
  let client: RazorpayLike;
  const createdSubscriptions: string[] = [];

  beforeAll(async () => {
    runId = newRunId();
    const { default: Razorpay } = await import('razorpay');
    client = new Razorpay({
      key_id: creds.keyId,
      key_secret: creds.keySecret,
    }) as unknown as RazorpayLike;
  });

  afterAll(async () => {
    for (const id of createdSubscriptions) {
      await client.subscriptions.cancel(id, false).catch(() => undefined);
    }
    await closeSandboxApp();
  });

  async function razorpayFixture(label: string, slug: string): Promise<SandboxFixture> {
    const fixture = await createFixture(label);
    await configureProvider(fixture, 'razorpay', {
      keyId: creds.keyId,
      keySecret: creds.keySecret,
      // Offline HMAC — the harness signs nothing here, so any stable value
      // works. It is required by the credential schema, so it is supplied.
      webhookSecret: `${HARNESS_PREFIX}-${runId}`,
    });
    await plansService.create({
      applicationId: fixture.applicationId,
      slug,
      name: `${HARNESS_PREFIX} Razorpay ${runId}`,
      amount: 50_000,
      currency: 'INR',
      interval: 'MONTH',
    });
    return fixture;
  }

  it('registers a plan lazily and returns a real authorization link', async () => {
    const fixture = await razorpayFixture('rzp-checkout', 'rzp-monthly');

    const res = await startCheckout(fixture, { planSlug: 'rzp-monthly', provider: 'razorpay' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      url: string;
      subscription: { metadata: Record<string, unknown> };
    };
    // Razorpay's hosted short link. Getting one back proves the plan create
    // and the subscription create both succeeded against the test key.
    expect(data.url).toMatch(/^https:\/\/rzp\.io\//);

    const providerSubId = data.subscription.metadata.checkoutSessionId as string;
    expect(providerSubId).toMatch(/^sub_/);
    createdSubscriptions.push(providerSubId);

    const atRazorpay = await client.subscriptions.fetch(providerSubId);
    // `created` — authorization has not happened yet, which is exactly the
    // state a local PENDING row should mirror.
    expect(atRazorpay.status).toBe('created');
    const local = await subscriptionBySession(fixture.applicationId, providerSubId);
    expect(local?.status).toBe('PENDING');
    expect(local?.provider).toBe('razorpay');
  });

  it('cancel at period end schedules at Razorpay — it does NOT terminate on the spot', async () => {
    const fixture = await razorpayFixture('rzp-cancel-pe', 'rzp-cancel');
    const res = await startCheckout(fixture, { planSlug: 'rzp-cancel', provider: 'razorpay' });
    const providerSubId = (res.json().data.subscription.metadata as Record<string, unknown>)
      .checkoutSessionId as string;
    createdSubscriptions.push(providerSubId);

    const local = await subscriptionBySession(fixture.applicationId, providerSubId);
    // Give the row the shape a completed authorization would have left, so the
    // cancel path takes the provider-backed branch. The row's STATE is the
    // fixture; what Razorpay does with the cancel is the thing under test.
    await prisma.subscription.update({
      where: { id: local!.id },
      data: {
        status: 'ACTIVE',
        providerSubId,
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
      },
    });

    const cancelled = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: {
        authorization: `Bearer ${fixture.liveKey}`,
        'x-rekey-user-token': fixture.userToken,
      },
      payload: { atPeriodEnd: true },
    });
    expect(cancelled.statusCode).toBeLessThan(300);

    const atRazorpay = await client.subscriptions.fetch(providerSubId);
    // The assertion the inverted argument failed. `cancelled` here would mean
    // the buyer lost the rest of a period they had paid for, while the local
    // row (still ACTIVE, `cancelAt` in the future) said otherwise.
    expect(
      atRazorpay.status,
      'cancel-at-period-end must leave the Razorpay subscription live until the cycle ends — ' +
        'a "cancelled" here is the inverted cancel_at_cycle_end argument coming back',
    ).not.toBe('cancelled');

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: local!.id } });
    expect(row.status).toBe('ACTIVE');
    expect(row.cancelAt).not.toBeNull();
  });

  it('refuses a recurring coupon rather than billing the plan price', async () => {
    const fixture = await razorpayFixture('rzp-coupon', 'rzp-discount');
    const { couponsService } = await import('../src/modules/coupons/coupons.service.js');
    await couponsService.create({
      applicationId: fixture.applicationId,
      code: `${HARNESS_PREFIX}-rzp`,
      discountType: 'AMOUNT',
      amountOff: 5_000,
      currency: 'INR',
    });

    const res = await startCheckout(fixture, {
      planSlug: 'rzp-discount',
      provider: 'razorpay',
      couponCode: `${HARNESS_PREFIX}-rzp`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('BILLING_DISCOUNT_UNSUPPORTED');
  });
});
