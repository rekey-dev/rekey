/**
 * A checkout whose delayed payment failed after the buyer finished it: a bank
 * debit (SEPA, ACH, Bacs) that Stripe reports with
 * `checkout.session.async_payment_failed`.
 *
 * The session was `complete` at Stripe, so the checkout page moved its row to
 * CONFIRMING and the in-flight guard has been refusing a second checkout for
 * the plan. No money arrived and none will, so the row is closed and marked,
 * and the coupon and trial slots it held go back, exactly as for a checkout
 * that ran out unpaid. Nothing was activated, so nothing is revoked locally;
 * the provider subscription the session created is cancelled.
 */

import { prisma } from '../../../lib/prisma.js';
import type { BillingProviderName } from '../credentials.service.js';
import { getProviderForApplication } from '../providers/index.js';
import type { CheckoutPaymentFailedEvent } from '../providers/module-types.js';
import type { ApplyContext } from './apply.js';

/** Set on a CheckoutSession's metadata; the in-flight guard skips a row carrying it. */
export const PAYMENT_FAILED_AT = 'paymentFailedAt';

/**
 * Stripe leaves a subscription whose first delayed payment failed `active`,
 * with the invoice voided, and bills it again next period. The checkout it
 * came from never activated, so that subscription is cancelled now; left
 * alone it would charge the buyer for a plan they do not have. A failed
 * cancellation fails the delivery so the provider retries it; the steps
 * before it are idempotent. An already-cancelled subscription is done.
 */
async function cancelProviderSubscription(ev: CheckoutPaymentFailedEvent, ctx: ApplyContext): Promise<void> {
  if (ev.providerSubscriptionId === null) return;
  const row = await prisma.checkoutSession.findFirst({
    where: { applicationId: ev.applicationId, providerSessionId: ev.checkoutSessionId },
    select: { provider: true, application: true, subscription: true },
  });
  // A local subscription that did activate under this id is live and paid for; never cancel it from here.
  if (row === null || row.subscription.providerSubId === ev.providerSubscriptionId) return;
  try {
    const provider = await getProviderForApplication(row.application, row.provider as BillingProviderName);
    await provider.cancelSubscription({
      subscription: { ...row.subscription, providerSubId: ev.providerSubscriptionId },
      atPeriodEnd: false,
    });
  } catch (err) {
    // Only "there is no such subscription" is final: it is already cancelled
    // (a re-delivery) or never existed. Anything else (a 5xx, a rate limit,
    // the network) is rethrown so the delivery answers 500 and Stripe sends
    // it again; swallowing it would leave the subscription billing.
    if ((err as { code?: unknown } | null)?.code !== 'resource_missing') throw err;
    ctx.log.info(
      { applicationId: ev.applicationId, providerSubscriptionId: ev.providerSubscriptionId },
      'the provider subscription of a checkout whose payment failed is already gone',
    );
  }
}

/**
 * @example
 * await applyCheckoutPaymentFailed(ev, ctx);
 */
export async function applyCheckoutPaymentFailed(ev: CheckoutPaymentFailedEvent, ctx: ApplyContext): Promise<void> {
  if (!ev.checkoutSessionId) {
    ctx.log.warn({ applicationId: ev.applicationId }, 'checkout payment failure carries no session id, ignored');
    return;
  }
  const closed = await prisma.$executeRaw`
    UPDATE checkout_sessions
    SET status = 'EXPIRED',
        metadata = jsonb_set(metadata, '{paymentFailedAt}', to_jsonb(${new Date().toISOString()}::text)),
        updated_at = NOW()
    WHERE application_id = ${ev.applicationId}
      AND provider_session_id = ${ev.checkoutSessionId}
      AND status IN ('OPEN', 'CONFIRMING', 'EXPIRED')`;
  const held = { applicationId: ev.applicationId, checkoutSessionId: ev.checkoutSessionId, status: 'RESERVED' as const };
  const coupons = await prisma.couponRedemption.deleteMany({ where: held });
  const trials = await prisma.trialRedemption.updateMany({ where: held, data: { status: 'RELEASED' } });
  await cancelProviderSubscription(ev, ctx);
  ctx.log.info(
    { applicationId: ev.applicationId, sessionId: ev.checkoutSessionId, closed, coupons: coupons.count, trials: trials.count },
    'checkout payment failed after completion: session closed and reservations released',
  );
}
