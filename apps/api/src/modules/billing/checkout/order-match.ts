/**
 * Whether PayPal's record of a one-time order is the purchase Rekey created:
 * this buyer's `custom_id` and the exact amount and currency the checkout
 * charged. Checked twice, by the page's "approved" (which moves no money) and
 * by the `CHECKOUT.ORDER.APPROVED` applier before it captures (which does).
 * The applier's check is the one that matters: an order re-priced at PayPal,
 * or one stamped for another buyer, must never be captured and fulfilled.
 */


import type { CheckoutSession } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { recordSecurityEvent } from '../../../lib/security-events.js';
import type { BillingProvider, ProviderOrderSnapshot } from '../providers/types.js';

/** What the provider was asked to charge for a one-time checkout. Smallest currency unit, upper-case ISO 4217. */
export interface ExpectedCharge {
  amount: number;
  currency: string;
}

export type OrderMismatch = 'unknown_at_paypal' | 'custom_id_mismatch' | 'currency_mismatch' | 'amount_mismatch';

/**
 * @example
 * orderMismatch(snapshot, 'ORDER-1', 'app_1:eu_1', { amount: 4999, currency: 'USD' }); // null when it matches
 */
export function orderMismatch(
  snapshot: ProviderOrderSnapshot | null,
  orderId: string,
  expectedCustomId: string,
  expected: ExpectedCharge,
): OrderMismatch | null {
  if (snapshot === null || snapshot.id !== orderId) return 'unknown_at_paypal';
  if (snapshot.customId !== expectedCustomId) return 'custom_id_mismatch';
  if (snapshot.currency !== expected.currency) return 'currency_mismatch';
  if (snapshot.amount !== expected.amount) return 'amount_mismatch';
  return null;
}

/**
 * What a one-time checkout must charge: the amount its session was opened at
 * less its discount, in the session's currency. Null for a recurring session,
 * whose first charge a trial or a proration can change.
 *
 * @example
 * expectedChargeOfSession(session); // { amount: 3999, currency: 'USD' }
 */
export function expectedChargeOfSession(
  session: Pick<CheckoutSession, 'kind' | 'currency' | 'chargeAmount'>,
): ExpectedCharge | null {
  if (session.kind !== 'ONE_TIME' || session.currency === null || session.chargeAmount === null) return null;
  return { amount: session.chargeAmount, currency: session.currency.toUpperCase() };
}

/**
 * What a one-time order must charge, from the CheckoutSession Rekey recorded
 * for it. Null when Rekey holds no session for the order, so there is nothing
 * to hold the order to and it must not be captured.
 *
 * @example
 * await expectedChargeForOrder(appId, 'ORDER-1'); // { amount: 3999, currency: 'USD' }
 */
export async function expectedChargeForOrder(applicationId: string, orderId: string): Promise<ExpectedCharge | null> {
  const session = await prisma.checkoutSession.findFirst({
    where: { applicationId, providerSessionId: orderId },
    orderBy: { createdAt: 'desc' },
    select: { kind: true, currency: true, chargeAmount: true },
  });
  return session === null ? null : expectedChargeOfSession(session);
}

/**
 * Read the order back from the provider and compare it with what this
 * checkout charged, before any money moves. A mismatch is recorded as a
 * security event; the caller does not capture.
 *
 * @example
 * const refused = await orderCaptureRefusal({ provider, application, subscription, orderId });
 * if (refused !== null) return; // not captured
 */
export async function orderCaptureRefusal(args: {
  provider: BillingProvider;
  application: { id: string; tenantId: string };
  subscription: { id: string; endUserId: string };
  orderId: string;
}): Promise<OrderMismatch | 'provider_cannot_verify' | 'no_checkout_session' | null> {
  const { provider, application, subscription, orderId } = args;
  const expected = await expectedChargeForOrder(application.id, orderId);
  const reason =
    expected === null
      ? 'no_checkout_session'
      : provider.getOrder
        ? orderMismatch(await provider.getOrder(orderId), orderId, `${application.id}:${subscription.endUserId}`, expected)
        : 'provider_cannot_verify';
  if (reason === null) return null;
  void recordSecurityEvent({
    type: 'app.checkout_capture_refused',
    actorType: 'system',
    tenantId: application.tenantId,
    applicationId: application.id,
    metadata: { subscriptionId: subscription.id, providerOrderId: orderId.slice(0, 64), reason, expected: expected === null ? null : { ...expected } },
  });
  return reason;
}
