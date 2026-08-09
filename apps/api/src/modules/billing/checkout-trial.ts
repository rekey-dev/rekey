/**
 * Checkout trial policy — the one place that decides whether a plan's free
 * trial may reach a payment provider, and refuses when it may not.
 *
 * The sibling of `checkout-discount.ts`, and it exists for the same reason.
 * A discount that never reached the processor charged the buyer full price
 * while our books recorded a discount. A trial that never reaches the
 * processor is worse in the same shape: the pricing page says "14 days free",
 * the buyer clicks, and the provider charges them today. That is a chargeback
 * and a support ticket, not a rendering bug, and the buyer is right.
 *
 * Two questions, both answered by refusing rather than approximating:
 *
 *   1. Does this plan even have a trial to apply? A trial belongs to a
 *      recurring subscription — a CREDIT pack or a perpetual licence has
 *      nothing to convert into.
 *   2. Can this provider express one? Answered by the module's
 *      `capabilities.trials`, fail-closed: an undeclared module counts as
 *      "cannot". Stripe runs trials natively; PayPal's Subscriptions v1 needs
 *      an intro cycle minted onto the plan, which is a different feature, and
 *      Razorpay likewise. Neither declares the capability, so neither is
 *      handed a trial it would silently drop.
 *
 * Refusing costs a checkout that could not have been honoured anyway, and it
 * fails while it is still free to fail: before the local Subscription row,
 * before any provider round-trip.
 */

import type { Plan } from '@prisma/client';
import { RekeyError } from '../../lib/error.js';
import { getModule } from './providers/registry.js';

/**
 * The trial to hand the provider, or null when the plan has none.
 *
 * Throws when the plan asks for a trial that this checkout cannot honour, so
 * a misconfiguration surfaces as a named refusal to the operator rather than
 * as an unexpected charge to the buyer.
 */
export function resolveCheckoutTrial(input: {
  plan: Plan;
  /** Registry name of the provider the checkout resolved to. */
  provider: string;
  /** True for CREDIT packs and perpetual licences — a single charge. */
  isOneTime: boolean;
}): { days: number } | null {
  const { plan, provider, isOneTime } = input;
  const days = plan.trialDays ?? 0;
  if (days <= 0) return null;

  if (isOneTime) {
    // Rejected at plan creation too. Kept here because a plan's `kind` can be
    // read from a row written before that rule existed, and a trial silently
    // ignored on a one-off charge is the failure this module exists to stop.
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_TRIAL_NOT_APPLICABLE',
      message: `Plan "${plan.slug}" has a trial, but a one-off purchase has nothing for a trial to convert into.`,
      fix: 'Remove `trialDays` from this plan, or make it a SUBSCRIPTION plan.',
    });
  }

  const module = getModule(provider);
  if (module?.capabilities.trials !== true) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_TRIAL_UNSUPPORTED',
      message: `The ${module?.display.label ?? provider} integration cannot start a subscription in a free trial, and plan "${plan.slug}" offers ${days} day(s).`,
      fix:
        'Route this plan to a provider that supports trials, or remove `trialDays` from the plan. ' +
        'Charging immediately for a plan advertised as a free trial is the one outcome this refuses.',
    });
  }

  return { days };
}
