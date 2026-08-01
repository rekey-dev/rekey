/**
 * Checkout discount policy — the one place that decides whether a validated
 * coupon may reach a payment provider, and refuses when it may not.
 *
 * Background worth keeping written down. `couponsService.validate` resolves a
 * code into an integer `discountAmount`; `billing.service` stamps that onto
 * `Subscription.metadata`, returns it to the caller, and redeems the coupon
 * when the payment succeeds. For the whole life of the coupons module none of
 * it ever reached the processor: `createCheckoutSession` was handed
 * `{ application, endUser, plan, successUrl, cancelUrl }` and nothing else. So
 * the buyer was charged full price while Rekey's own books said they got a
 * discount and consumed a redemption. This module is the gate on the seam
 * that now carries it.
 *
 * Two questions, and both answer by refusing rather than approximating:
 *
 *   1. Can this provider apply the discount on this flow? Answered by the
 *      module's `capabilities.discounts`, fail-closed — an undeclared module
 *      counts as "cannot". PayPal and Razorpay can discount a one-off charge
 *      and cannot discount a single period of a recurring subscription; the
 *      why lives in their module descriptors.
 *   2. Is the resulting charge one a provider will actually accept?
 *
 * What is deliberately NOT re-checked here: the discount's sign and ceiling.
 * `couponsService.computeDiscount` floors PERCENT to whole units and clamps
 * both kinds with `Math.min(raw, amount)`, and coupon creation rejects a
 * negative `amountOff` and a PERCENT over 10000bp — so `0 <= discountAmount
 * <= plan.amount` already holds by construction. The over-price branch below
 * is a tripwire on that invariant, not a second implementation of it: a
 * provider call is the wrong place to discover the clamp regressed.
 */

import type { Plan } from '@prisma/client';
import { RekeyError } from '../../lib/error.js';
import { discountUnsupported } from './providers/discount.js';
import { getModule } from './providers/registry.js';
import type { CheckoutDiscount } from './providers/types.js';

/**
 * Turn a validated coupon into the discount the provider will be handed, or
 * throw the reason it cannot be. Called once per checkout, before the
 * provider is constructed, so a refusal costs nothing but the validation
 * queries — no local Subscription row, no redemption, no provider round-trip.
 */
export function resolveCheckoutDiscount(input: {
  plan: Plan;
  /** Registry name of the provider the checkout resolved to. */
  provider: string;
  /** True for CREDIT packs and perpetual licences — a single charge. */
  isOneTime: boolean;
  coupon: { couponId: string; code: string; discountAmount: number };
}): CheckoutDiscount {
  const { plan, provider, isOneTime, coupon } = input;

  if (coupon.discountAmount <= 0) {
    // Reachable without anything being broken: a PERCENT coupon floors to
    // whole units, so 1% of a 50-cent plan is 0. Refuse rather than send a
    // zero discount (Stripe rejects `amount_off: 0` outright) or, worse,
    // accept it and burn one of the buyer's redemptions on nothing.
    throw new RekeyError({
      statusCode: 400,
      code: 'COUPON_NO_DISCOUNT',
      message: `Coupon "${coupon.code}" works out to no discount on plan "${plan.slug}".`,
      fix: 'The discount rounds down to zero at this price. Use a coupon worth at least one unit of the plan currency.',
    });
  }

  if (coupon.discountAmount > plan.amount) {
    // Tripwire — couponsService clamps to the plan amount, so reaching this
    // means that clamp broke. Never send it on: a discount larger than the
    // price is a negative charge, which is a refund with no audit trail.
    throw new RekeyError({
      statusCode: 500,
      code: 'COUPON_DISCOUNT_EXCEEDS_PRICE',
      message: `Coupon "${coupon.code}" resolved to a discount larger than plan "${plan.slug}".`,
      fix: 'This is a Rekey bug — the coupon service is expected to clamp the discount to the plan amount. Report it with the coupon code and plan slug.',
    });
  }

  const module = getModule(provider);
  const supported = isOneTime
    ? module?.capabilities.discounts?.oneTime
    : module?.capabilities.discounts?.recurring;
  if (supported !== true) {
    throw discountUnsupported(provider, isOneTime ? 'one-time' : 'recurring');
  }

  if (isOneTime && coupon.discountAmount === plan.amount) {
    // A fully comped one-off has nowhere to land. Every hosted one-time
    // surface we drive needs a positive amount (Stripe enforces a minimum
    // charge, a PayPal order of 0.00 is rejected, a Razorpay payment link of 0
    // is rejected), and fulfilment — the credit grant, the licence issue —
    // hangs off the payment-succeeded webhook, which never fires without a
    // charge. So the buyer would pay nothing and receive nothing.
    //
    // The recurring case is not refused here on purpose: a provider that
    // declares `discounts.recurring` settles a zero first invoice as paid and
    // still emits the activation, so a 100%-off first period works end to end.
    throw new RekeyError({
      statusCode: 400,
      code: 'COUPON_FULL_DISCOUNT_UNSUPPORTED',
      message: `Coupon "${coupon.code}" covers the full price of "${plan.slug}", and a one-time purchase cannot be checked out for zero.`,
      fix: 'Use a coupon worth less than the full price, or grant the credits/licence directly from the operator panel instead of charging for them.',
    });
  }

  return {
    amount: coupon.discountAmount,
    currency: plan.currency,
    couponId: coupon.couponId,
    code: coupon.code,
  };
}
