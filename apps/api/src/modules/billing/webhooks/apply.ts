/**
 * Dispatches one normalized billing event to its applier
 * (docs/specs/billing-provider-modules.md). Provider payload shapes and status
 * maps stay in the modules' `translate`; the appliers own the domain writes:
 *
 *   - `apply-granted.ts`: a subscription sold by a system Rekey never called
 *   - `apply-checkout.ts`: a checkout completed, or a one-time order approved
 *   - `apply-payment.ts`, `apply-payment-failed.ts`: a charge succeeded, or failed
 *   - `apply-refund.ts`: money went back
 *   - `apply-status.ts`: the status mirror and the local period advance
 *
 * What they all hold to: a payment row, the subscription change it causes,
 * the billing log events and the outbound webhook rows commit in one
 * transaction; coupon redemption, dunning and provisioning run after it and
 * can never undo it; and a charge that cannot be applied is still recorded.
 */

import type { DomainBillingEvent } from '../providers/module-types.js';
import { applyCheckoutPaymentFailed } from './apply-checkout-payment-failed.js';
import { applyCheckoutApproved, applyCheckoutCompleted } from './apply-checkout.js';
import { applySubscriptionGranted } from './apply-granted.js';
import { applyPaymentFailed } from './apply-payment-failed.js';
import { applyPaymentSucceeded } from './apply-payment.js';
import { applyPaymentRefunded } from './apply-refund.js';
import { applySubscriptionPeriodAdvanced, applySubscriptionStatusMirror } from './apply-status.js';
import type { ApplyContext } from './apply-shared.js';

export type { ApplyContext } from './apply-shared.js';
export { applyCheckoutApproved, applyCheckoutCompleted } from './apply-checkout.js';
export { applySubscriptionGranted } from './apply-granted.js';
export { applyPaymentFailed } from './apply-payment-failed.js';
export { applyPaymentSucceeded } from './apply-payment.js';
export { applyPaymentRefunded } from './apply-refund.js';
export { applySubscriptionPeriodAdvanced } from './apply-status.js';

/**
 * @example
 * await applyBillingEvent(event, { log: req.log, provider: 'stripe', mode: 'live' });
 */
export async function applyBillingEvent(ev: DomainBillingEvent, ctx: ApplyContext): Promise<void> {
  switch (ev.type) {
    case 'subscription.granted':
      return applySubscriptionGranted(ev, ctx);
    case 'checkout.completed':
      return applyCheckoutCompleted(ev, ctx);
    case 'checkout.approved':
      return applyCheckoutApproved(ev, ctx);
    case 'checkout.payment_failed':
      return applyCheckoutPaymentFailed(ev, ctx);
    case 'payment.succeeded':
      return applyPaymentSucceeded(ev, ctx);
    case 'payment.failed':
      return applyPaymentFailed(ev, ctx);
    case 'payment.refunded':
      return applyPaymentRefunded(ev, ctx);
    case 'subscription.activated':
    case 'subscription.canceled':
    case 'subscription.past_due':
      return applySubscriptionStatusMirror(ev, ctx);
    case 'subscription.period_advanced':
      return applySubscriptionPeriodAdvanced(ev, ctx);
  }
}
