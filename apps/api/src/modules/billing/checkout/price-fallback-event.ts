/**
 * The billing log's record of a checkout that charges the default price
 * because no provider could charge the one selected for the buyer.
 */

import type { CheckoutSession, Prisma } from '@prisma/client';
import { recordMoneyPathBillingEvent } from '../../billing-log/index.js';
import type { PriceFallback } from '../checkout-price.js';

const BELIEVED_SOURCES = new Set(['declared', 'vouched', 'hint']);

/**
 * The billing log's record that a buyer was charged the default price because
 * no provider could charge the one selected for them. Written with the
 * session, so a fallback with no record of it does not exist.
 */
export async function recordPriceFallback(
  tx: Prisma.TransactionClient,
  session: CheckoutSession,
  plan: { id: string; slug: string },
  fallback: PriceFallback,
): Promise<void> {
  if (session.planPriceId === null || session.currency === null || session.unitAmount === null) return;
  const country = session.buyerCountry !== null && /^[A-Z]{2}$/.test(session.buyerCountry) ? session.buyerCountry : null;
  const source =
    country !== null && session.buyerCountrySource !== null && BELIEVED_SOURCES.has(session.buyerCountrySource)
      ? (session.buyerCountrySource as 'declared' | 'vouched' | 'hint')
      : null;
  // The provider session already exists, so a refused event must not fail the checkout.
  await recordMoneyPathBillingEvent(tx, {
    type: 'checkout.price_fallback',
    applicationId: session.applicationId,
    actor: { type: 'end_user', id: session.endUserId },
    endUserId: session.endUserId,
    subscriptionId: session.subscriptionId,
    checkoutSessionId: session.id,
    planId: plan.id,
    planPriceId: session.planPriceId,
    provider: session.provider,
    currency: session.currency.toUpperCase(),
    amount: session.unitAmount,
    data: {
      planSlug: plan.slug,
      requested: {
        planPriceId: fallback.requested.planPriceId,
        currency: fallback.requested.currency,
        amount: fallback.requested.amount,
      },
      charged: { planPriceId: session.planPriceId, currency: session.currency.toUpperCase(), amount: session.unitAmount },
      reason: fallback.reason,
      buyerCountry: country,
      buyerCountrySource: source,
    },
  });
}
