/**
 * Checkout discount policy, the one place that decides whether a validated
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
 *      module's `capabilities.discounts`, fail-closed, an undeclared module
 *      counts as "cannot". PayPal and Razorpay can discount a one-off charge
 *      and cannot discount a single period of a recurring subscription; the
 *      why lives in their module descriptors.
 *   2. Is the resulting charge one a provider will actually accept?
 *
 * What is deliberately NOT re-decided here: the discount's size.
 * `computeDiscount` (coupons/coupon-terms.ts) rounds a percentage toward the
 * buyer and caps both kinds at the price, in the currency charged, and
 * `couponsService.validate` refuses a coupon that takes nothing off. So
 * `0 < discountAmount <= plan.amount` already holds. The two branches below
 * that test it are tripwires on that invariant, not a second implementation:
 * a provider call is the wrong place to discover it regressed.
 *
 * The coupon preview calls this too, with the provider the checkout would
 * pick, so the place a code is entered and the checkout give one answer.
 * Each refusal is recorded in the billing log as `coupon.refused`.
 */

import type { PricedPlan } from './providers/types.js';
import { RekeyError } from '../../lib/error.js';
import { discountUnsupported } from './providers/discount.js';
import { getModule } from './providers/registry.js';
import type { CheckoutDiscount } from './providers/types.js';
import { recordCouponRefused } from '../coupons/coupon-events.js';
import type { BillingLogLogger } from '../billing-log/index.js';

interface CheckoutDiscountInput {
  plan: PricedPlan;
  /** Registry name of the provider the checkout resolved to. */
  provider: string;
  /** True for CREDIT packs and perpetual licences, a single charge. */
  isOneTime: boolean;
  coupon: { couponId: string; code: string; discountAmount: number };
}

/**
 * Turn a validated coupon into the discount the provider will be handed, or
 * throw the reason it cannot be. Called once per checkout, before the
 * provider is constructed, so a refusal costs nothing but the validation
 * queries, no local Subscription row, no redemption, no provider round-trip.
 * A refusal is recorded in the billing log as `coupon.refused`.
 */
export function resolveCheckoutDiscount(
  input: CheckoutDiscountInput & {
    /** The buyer, for the billing log's record of a refusal. */
    endUserId?: string | undefined;
    log?: BillingLogLogger | undefined;
  },
): CheckoutDiscount {
  try {
    return decideCheckoutDiscount(input);
  } catch (error) {
    if (error instanceof RekeyError) {
      const { plan, coupon } = input;
      // Not awaited: the refusal is the answer. The catch is what keeps a
      // failed log write from ending the process as an unhandled rejection.
      recordCouponRefused({
        coupon: { id: coupon.couponId, applicationId: plan.applicationId, code: coupon.code },
        endUserId: input.endUserId,
        planId: plan.id,
        planSlug: plan.slug,
        reasonCode: error.code,
        chargedCurrency: plan.currency.toUpperCase(),
      }).catch((err: unknown) => {
        (input.log ?? console).warn({ err, couponId: coupon.couponId }, 'billing log: coupon refusal not recorded');
      });
    }
    throw error;
  }
}

/**
 * The decision `resolveCheckoutDiscount` makes, with nothing recorded: for a
 * caller that asks what a checkout would do without a buyer opening one.
 *
 * @example
 * decideCheckoutDiscount({ plan: priced, provider: 'stripe', isOneTime: false, coupon: { couponId, code: 'LAUNCH', discountAmount: 300 } });
 */
export function decideCheckoutDiscount(input: CheckoutDiscountInput): CheckoutDiscount {
  const { plan, provider, isOneTime, coupon } = input;
  const refuse = (error: RekeyError): never => {
    throw error;
  };

  if (coupon.discountAmount <= 0) {
    // Tripwire: `couponsService.validate` refuses this first. Never send a
    // zero discount on (Stripe rejects `amount_off: 0` outright) or burn one
    // of the buyer's redemptions on nothing.
    refuse(
      new RekeyError({
        statusCode: 400,
        code: 'COUPON_NO_DISCOUNT',
        message: `Coupon "${coupon.code}" works out to no discount on plan "${plan.slug}".`,
        fix: 'Check out without `couponCode` to pay the full price. This coupon takes nothing off this price.',
      }),
    );
  }

  if (coupon.discountAmount > plan.amount) {
    // Tripwire: the discount is capped at the price where it is computed, so
    // reaching this means that cap broke. Never send it on: a discount larger
    // than the price is a negative charge, which is a refund with no audit trail.
    refuse(
      new RekeyError({
        statusCode: 500,
        code: 'COUPON_DISCOUNT_EXCEEDS_PRICE',
        message: `Coupon "${coupon.code}" resolved to a discount larger than plan "${plan.slug}".`,
        fix: 'This is a Rekey bug: a discount is capped at the price it is taken off. Report it with the coupon code and plan slug.',
      }),
    );
  }

  const module = getModule(provider);
  const supported = isOneTime
    ? module?.capabilities.discounts?.oneTime
    : module?.capabilities.discounts?.recurring;
  if (supported !== true) {
    refuse(discountUnsupported(provider, isOneTime ? 'one-time' : 'recurring'));
  }

  if (isOneTime && coupon.discountAmount === plan.amount) {
    // A fully comped one-off has nowhere to land. Every hosted one-time
    // surface we drive needs a positive amount (Stripe enforces a minimum
    // charge, a PayPal order of 0.00 is rejected, a Razorpay payment link of 0
    // is rejected), and fulfilment, the credit grant, the licence issue,
    // hangs off the payment-succeeded webhook, which never fires without a
    // charge. So the buyer would pay nothing and receive nothing.
    //
    // The recurring case is not refused here on purpose: a provider that
    // declares `discounts.recurring` settles a zero first invoice as paid and
    // still emits the activation, so a 100%-off first period works end to end.
    refuse(
      new RekeyError({
        statusCode: 400,
        code: 'COUPON_FULL_DISCOUNT_UNSUPPORTED',
        message: `Coupon "${coupon.code}" covers the full ${plan.currency.toUpperCase()} price of "${plan.slug}", and a one-time purchase cannot be checked out for zero.`,
        fix: 'Use a coupon worth less than the full price, or grant the credits/licence directly from the operator panel instead of charging for them.',
      }),
    );
  }

  return {
    amount: coupon.discountAmount,
    currency: plan.currency,
    couponId: coupon.couponId,
    code: coupon.code,
  };
}
