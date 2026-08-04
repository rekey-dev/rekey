/**
 * Driving a real subscription lifecycle in a Stripe test account.
 *
 * Stripe test mode has no API that completes a hosted Checkout Session — the
 * supported route is a test card on the hosted page, which
 * `stripe-checkout-browser.test.ts` drives and which not every environment can
 * run. Everything AFTER the completion, though, is reachable from the API:
 * create a customer with a test card, subscribe them to the Price our own plan
 * registration minted, and Stripe performs the same billing cycle, emits the
 * same events and answers the same objects it would have for a buyer who
 * clicked through.
 *
 * So the suites use this to reach the states the webhook path has to handle,
 * and are explicit about the ONE link it does not establish: the local
 * Subscription row's `providerSubId`. In production that is written by
 * `checkout.session.completed`. Here `linkProviderSubscription` writes it
 * directly, and it is the only fabricated step in any of these tests —
 * everything downstream of it (the events, their contents, their timing, what
 * Stripe does when a period ends) is the provider's.
 *
 * Test clocks are used wherever a subscription is created, for two reasons:
 * deleting the clock deletes its customers and subscriptions in one call, and
 * a clock is the only way to observe what Stripe does when a period actually
 * ends — which is precisely the half of PR #336 that had never been exercised.
 */

import type Stripe from 'stripe';
import { prisma } from '../../src/lib/prisma.js';
import { HARNESS_METADATA, HARNESS_PREFIX } from './naming.js';
import type { StripeJanitor } from './stripe-sandbox.js';

/**
 * Stripe's shared test PaymentMethod for a card that always succeeds.
 *
 * A documented test-mode value, not a token minted here: creating a real
 * PaymentMethod would need raw card numbers in this repository, which is
 * exactly what these ids exist to avoid.
 */
export const TEST_CARD_PAYMENT_METHOD = 'pm_card_visa';

export interface LiveSubscription {
  clockId: string;
  customerId: string;
  subscription: Stripe.Subscription;
}

/**
 * Create a test clock, a customer holding a working card, and an active
 * subscription to `priceId` carrying Rekey's routing metadata.
 *
 * `metadata` must match what `createCheckoutSession` puts on
 * `subscription_data.metadata`, because the webhook translator routes on it.
 */
export async function createLiveSubscription(
  stripe: Stripe,
  janitor: StripeJanitor,
  args: {
    runId: string;
    priceId: string;
    metadata: { applicationId: string; endUserId: string; planId: string };
  },
): Promise<LiveSubscription> {
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: Math.floor(Date.now() / 1000),
    name: `${HARNESS_PREFIX}-${args.runId}`,
  });
  janitor.track('testClock', clock.id);

  const customer = await stripe.customers.create({
    email: `${HARNESS_PREFIX}-${args.runId}@example.com`,
    test_clock: clock.id,
    payment_method: TEST_CARD_PAYMENT_METHOD,
    invoice_settings: { default_payment_method: TEST_CARD_PAYMENT_METHOD },
    metadata: { ...HARNESS_METADATA },
  });
  janitor.track('customer', customer.id);

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: args.priceId, quantity: 1 }],
    default_payment_method: TEST_CARD_PAYMENT_METHOD,
    // Fail loudly instead of leaving an `incomplete` subscription behind: a
    // test that silently proceeds against an unpaid subscription proves the
    // opposite of what it claims.
    payment_behavior: 'error_if_incomplete',
    metadata: args.metadata,
    expand: ['latest_invoice'],
  });
  janitor.track('subscription', subscription.id);

  return { clockId: clock.id, customerId: customer.id, subscription };
}

/**
 * Write the provider subscription id onto the local row.
 *
 * THE ONE FABRICATED STEP. In production `applyCheckoutCompleted` does this
 * from a genuine `checkout.session.completed`, which cannot be produced
 * without completing a hosted page. Nothing else about the row is touched —
 * it stays PENDING, exactly as the checkout left it, so the status transition
 * under test is still driven entirely by the provider's events.
 */
export async function linkProviderSubscription(
  subscriptionRowId: string,
  providerSubId: string,
): Promise<void> {
  await prisma.subscription.update({
    where: { id: subscriptionRowId },
    data: { providerSubId },
  });
}

/**
 * Advance a test clock and wait for Stripe to finish replaying the billing
 * cycles that fall inside the jump.
 *
 * The clock's `status` goes `advancing` → `ready`; polling it is the only
 * reliable signal that the events it produces have been emitted.
 */
export async function advanceClock(
  stripe: Stripe,
  clockId: string,
  toUnixSeconds: number,
  timeoutMs = 120_000,
): Promise<void> {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: toUnixSeconds });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === 'ready') return;
    if (clock.status === 'internal_failure') {
      throw new Error(`Stripe test clock ${clockId} reported internal_failure while advancing.`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`Stripe test clock ${clockId} did not become ready within ${timeoutMs}ms.`);
}

/**
 * The period end Stripe reports for a subscription, as a Date.
 *
 * Read from the provider rather than computed locally on purpose: "when does
 * this period end" is the provider's answer, and `advanceBillingPeriod`'s
 * local arithmetic is a different thing that a sandbox run is entitled to
 * disagree with.
 */
export function periodEnd(subscription: Stripe.Subscription): Date {
  return new Date(subscription.current_period_end * 1000);
}
