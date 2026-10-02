import type Stripe from 'stripe';
import { planNotRegisteredError } from '../../plans/plan-registration.js';
import type { CheckoutSessionInput } from './types.js';

type SessionParams = Stripe.Checkout.SessionCreateParams;
type Discounts = Stripe.Checkout.SessionCreateParams.Discount[] | undefined;

/**
 * The Checkout Session arguments that describe the purchase itself, shared by
 * every presentation (Stripe's hosted page, the Rekey page in `ui_mode:
 * 'elements'`, and the hosted fallback for an embedded session). Only where
 * the buyer returns to differs between them, so it is left to the caller.
 */
export type PurchaseParams = Omit<SessionParams, 'success_url' | 'cancel_url' | 'return_url' | 'ui_mode'>;

function rekeyMetadata(input: CheckoutSessionInput): Record<string, string> {
  return { applicationId: input.application.id, endUserId: input.endUser.id, planId: input.plan.id };
}

/**
 * The plan's registered Stripe price, or the named 409 for a plan that never
 * got one.
 *
 * @example
 * const priceId = stripePriceIdFor(input);
 */
export function stripePriceIdFor(input: CheckoutSessionInput): string {
  const priceId = (input.plan.metadata as { stripe?: { priceId?: string } } | null)?.stripe?.priceId;
  if (!priceId) {
    // Reachable, and it was reached: a plan whose eager registration was
    // refused used to be committed active anyway. `plansService` now keeps
    // such a plan off the catalogue, and a legacy row still lands here with
    // the operator's repair instead of a bare 500.
    throw planNotRegisteredError({
      planSlug: input.plan.slug,
      provider: 'Stripe',
      applicationId: input.application.id,
    });
  }
  return priceId;
}

/**
 * A recurring purchase: the plan's price, the buyer's email, the discount and
 * the trial.
 *
 * No `payment_method_types`: Checkout offers what the account enables (Link,
 * wallets, local methods). Delayed methods complete unpaid, which the webhook
 * translator holds until `async_payment_succeeded`.
 *
 * `applicationId` rides on the session so the webhook handler can route the
 * event back to the right local Subscription. Invoices do not inherit it on
 * their own `metadata`: Stripe snapshots `subscription_data.metadata` onto
 * each invoice's subscription details, and the translator reads it there.
 *
 * @example
 * await stripe.checkout.sessions.create({ ...subscriptionPurchase(input, priceId, discounts), success_url, cancel_url });
 */
export function subscriptionPurchase(input: CheckoutSessionInput, priceId: string, discounts: Discounts): PurchaseParams {
  return {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: input.endUser.email,
    ...(discounts && { discounts }),
    metadata: rekeyMetadata(input),
    subscription_data: {
      // Stripe runs the clock and charges when it ends, reporting `trialing`
      // until then, which `mapStripeSubStatus` surfaces as TRIALING.
      ...(input.trial && { trial_period_days: input.trial.days }),
      metadata: rekeyMetadata(input),
    },
  };
}

/**
 * A one-time purchase: inline `price_data` at the plan's price, so the buyer
 * sees a subtotal and a discount line rather than a reduced unit price.
 *
 * @example
 * await stripe.checkout.sessions.create({ ...paymentPurchase(input, discounts), success_url, cancel_url });
 */
export function paymentPurchase(input: CheckoutSessionInput, discounts: Discounts): PurchaseParams {
  return {
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: input.plan.currency.toLowerCase(),
          unit_amount: input.plan.amount,
          product_data: { name: input.plan.name },
        },
      },
    ],
    customer_email: input.endUser.email,
    ...(discounts && { discounts }),
    metadata: rekeyMetadata(input),
    payment_intent_data: { metadata: rekeyMetadata(input) },
  };
}
