/**
 * Cancellation, both shapes, against the real provider — the half of PR #336
 * that has never been exercised.
 *
 * #336 separated two mechanisms that used to be one predicate:
 *
 *   - a subscription with NO provider record is scheduled locally and expired
 *     lazily on read by `expireIfDue`;
 *   - a **provider-backed** subscription is scheduled at the provider and
 *     terminated by the provider's own webhook when the date arrives.
 *
 * The first half has unit coverage (`test/cancel-at-period-end.test.ts`). The
 * second was asserted only against a fake whose `cancelSubscription` did
 * nothing and returned, so three separate claims went untested: that Stripe
 * records the schedule at all, that the local row stays ACTIVE and entitled
 * until the date, and that Stripe really does emit the termination when the
 * period ends.
 *
 * The third is what the test clock is for. Advancing past `current_period_end`
 * makes Stripe run the cycle for real, and whatever it emits — that is the
 * event the production system will one day receive.
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
import {
  advanceClock,
  createLiveSubscription,
  linkProviderSubscription,
  periodEnd,
} from './support/stripe-lifecycle.js';

describeSandbox('stripe', 'Stripe sandbox · cancellation', stripeSandbox, (creds) => {
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

  /** A provider-backed ACTIVE subscription — the shape #336 could not test. */
  async function activeProviderBackedSubscription(label: string): Promise<{
    fixture: SandboxFixture;
    localSubscriptionId: string;
    stripeSubscription: Stripe.Subscription;
    clockId: string;
    since: number;
  }> {
    const fixture = await createFixture(label);
    await configureStripe(fixture, creds.apiKey);

    const plan = await plansService.create({
      applicationId: fixture.applicationId,
      slug: 'monthly',
      name: `${HARNESS_PREFIX} Cancellable ${runId}`,
      amount: 1900,
      currency: 'usd',
      interval: 'MONTH',
    });
    await entitlementsService.upsert({
      planId: plan.id,
      kind: 'FEATURE',
      key: 'pro',
      valueType: 'BOOL',
      value: 'true',
    });
    const priceId = (plan.metadata as { stripe?: { priceId?: string } }).stripe?.priceId!;
    const price = await stripe.prices.retrieve(priceId);
    janitor.track('product', typeof price.product === 'string' ? price.product : price.product.id);

    const checkout = await startCheckout(fixture, { planSlug: 'monthly' });
    const sessionId = (checkout.json().data.subscription.metadata as Record<string, unknown>)
      .checkoutSessionId as string;
    janitor.track('checkoutSession', sessionId);
    const local = await subscriptionBySession(fixture.applicationId, sessionId);

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

    // Activate through the provider's own `invoice.paid`, so the row reaches
    // ACTIVE the way production does rather than by a direct write.
    const paid = await waitForStripeEvents(stripe, {
      types: ['invoice.paid'],
      since,
      expect: 1,
      match: (e) =>
        (e.data.object as { subscription?: unknown }).subscription === live.subscription.id,
    });
    expect(paid, 'no invoice.paid — the subscription was never charged').toHaveLength(1);
    await deliverStripeEvent(fixture, paid[0]!);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: local!.id } });
    expect(row.status).toBe('ACTIVE');
    // The period the buyer has paid for, as STRIPE reports it. Everything
    // below turns on this date, so it comes from the provider.
    await prisma.subscription.update({
      where: { id: local!.id },
      data: { currentPeriodEnd: periodEnd(live.subscription) },
    });

    return {
      fixture,
      localSubscriptionId: local!.id,
      stripeSubscription: live.subscription,
      clockId: live.clockId,
      since,
    };
  }

  const cancel = (fixture: SandboxFixture, atPeriodEnd: boolean) =>
    fixture.app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: {
        authorization: `Bearer ${fixture.liveKey}`,
        'x-rekey-user-token': fixture.userToken,
      },
      payload: { atPeriodEnd },
    });

  it('at period end: Stripe schedules it, the buyer keeps the period, Stripe ends it', async () => {
    const scenario = await activeProviderBackedSubscription('cancel-pe');

    const res = await cancel(scenario.fixture, true);
    expect(res.statusCode).toBeLessThan(300);

    // --- 1. Stripe recorded the schedule -----------------------------------
    const atStripe = await stripe.subscriptions.retrieve(scenario.stripeSubscription.id);
    expect(atStripe.cancel_at_period_end).toBe(true);
    expect(atStripe.status).toBe('active');
    expect(atStripe.cancel_at).toBe(scenario.stripeSubscription.current_period_end);

    // --- 2. Locally the buyer still has what they paid for ------------------
    const scheduled = await prisma.subscription.findUniqueOrThrow({
      where: { id: scenario.localSubscriptionId },
    });
    expect(scheduled.status).toBe('ACTIVE');
    expect(scheduled.cancelAt).not.toBeNull();
    expect(await readEntitlements(scenario.fixture)).toMatchObject({
      features: { pro: true },
    });

    // …including after the provider's own `customer.subscription.updated`
    // lands. This is the event that used to have no coverage at all, and the
    // one that would revoke the period early if the translator read
    // `cancel_at_period_end` as "canceled".
    const updated = await waitForStripeEvents(stripe, {
      types: ['customer.subscription.updated'],
      since: scenario.since,
      expect: 1,
      match: (e) => {
        const sub = e.data.object as Stripe.Subscription;
        return sub.id === scenario.stripeSubscription.id && sub.cancel_at_period_end === true;
      },
    });
    expect(updated.length).toBeGreaterThan(0);
    const ack = await deliverStripeEvent(scenario.fixture, updated[updated.length - 1]!);
    expect(ack.statusCode).toBe(200);

    const afterEvent = await prisma.subscription.findUniqueOrThrow({
      where: { id: scenario.localSubscriptionId },
    });
    expect(
      afterEvent.status,
      'a scheduled cancellation must not terminate the subscription early — that is the ' +
        'defect PR #336 fixed on the provider-less side, and this is the provider-backed side',
    ).toBe('ACTIVE');
    expect(afterEvent.cancelAt?.getTime()).toBe(periodEnd(scenario.stripeSubscription).getTime());
    expect((await readEntitlements(scenario.fixture)).features.pro).toBe(true);

    // --- 3. When the period genuinely ends, Stripe terminates it ------------
    // The claim `expireIfDue` exists to make safe: "a provider-backed row
    // waits for the provider's webhook". Nothing local ends it, so if Stripe
    // does not emit here, a cancelled buyer stays entitled forever.
    const afterPeriod = scenario.stripeSubscription.current_period_end + 3600;
    await advanceClock(stripe, scenario.clockId, afterPeriod);

    const deleted = await waitForStripeEvents(stripe, {
      types: ['customer.subscription.deleted'],
      since: scenario.since,
      expect: 1,
      match: (e) => (e.data.object as Stripe.Subscription).id === scenario.stripeSubscription.id,
      timeoutMs: 90_000,
    });
    expect(
      deleted,
      'Stripe emitted no customer.subscription.deleted after the period it was scheduled to ' +
        'cancel at. A provider-backed row has no local expiry path, so this event is the ONLY ' +
        'thing that ends it.',
    ).toHaveLength(1);

    await deliverStripeEvent(scenario.fixture, deleted[0]!);
    const terminated = await prisma.subscription.findUniqueOrThrow({
      where: { id: scenario.localSubscriptionId },
    });
    expect(terminated.status).toBe('CANCELED');
    expect(terminated.canceledAt).not.toBeNull();
    expect((await readEntitlements(scenario.fixture)).features.pro).toBeUndefined();
  });

  it('immediately: Stripe cancels on the spot and the entitlement goes with it', async () => {
    const scenario = await activeProviderBackedSubscription('cancel-now');

    const res = await cancel(scenario.fixture, false);
    expect(res.statusCode).toBeLessThan(300);

    const atStripe = await stripe.subscriptions.retrieve(scenario.stripeSubscription.id);
    expect(atStripe.status).toBe('canceled');
    expect(atStripe.canceled_at).toBeTruthy();
    // Not a schedule — the difference between the two shapes, at the provider.
    expect(atStripe.cancel_at_period_end).toBe(false);

    const local = await prisma.subscription.findUniqueOrThrow({
      where: { id: scenario.localSubscriptionId },
    });
    expect(local.status).toBe('CANCELED');
    expect((await readEntitlements(scenario.fixture)).features.pro).toBeUndefined();

    // And the provider's own event agrees, replayed for good measure — a
    // terminal row must stay terminal.
    const deleted = await waitForStripeEvents(stripe, {
      types: ['customer.subscription.deleted'],
      since: scenario.since,
      expect: 1,
      match: (e) => (e.data.object as Stripe.Subscription).id === scenario.stripeSubscription.id,
    });
    expect(deleted).toHaveLength(1);
    await deliverStripeEvent(scenario.fixture, deleted[0]!);
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: scenario.localSubscriptionId },
    });
    expect(after.status).toBe('CANCELED');
  });
});
