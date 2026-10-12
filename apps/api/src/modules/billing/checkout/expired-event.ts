/**
 * The billing log's record that a checkout can no longer be paid: it ran out
 * of time, its delayed payment failed, or the provider's credentials moved to
 * the other payment mode under it.
 */

import { prisma } from '../../../lib/prisma.js';
import { recordDiagnosticBillingEvent } from '../../billing-log/index.js';

/**
 * Written once per session, whichever read or event noticed first. Never
 * throws: the session is already closed, and the log must not be the reason a
 * page read or a webhook fails.
 *
 * @example
 * await logCheckoutExpired(session.id, 'timed_out');
 */
export async function logCheckoutExpired(
  checkoutSessionId: string,
  reason: 'timed_out' | 'payment_failed' | 'mode_mismatch',
): Promise<void> {
  const session = await prisma.checkoutSession
    .findUnique({
      where: { id: checkoutSessionId },
      select: {
        id: true,
        applicationId: true,
        endUserId: true,
        subscriptionId: true,
        provider: true,
        planPriceId: true,
        currency: true,
        chargeAmount: true,
        subscription: { select: { planId: true, plan: { select: { slug: true } } } },
      },
    })
    .catch(() => null);
  if (session === null) return;
  const currency = session.currency?.toUpperCase();
  await recordDiagnosticBillingEvent({
    type: 'checkout.expired',
    applicationId: session.applicationId,
    dedupeKey: `checkout.expired:${session.id}`,
    actor: { type: 'system' },
    endUserId: session.endUserId,
    subscriptionId: session.subscriptionId,
    checkoutSessionId: session.id,
    planId: session.subscription.planId,
    ...(session.planPriceId !== null && { planPriceId: session.planPriceId }),
    ...(/^[A-Za-z0-9_.:-]{1,120}$/.test(session.provider) && { provider: session.provider }),
    ...(currency !== undefined && /^[A-Z]{3}$/.test(currency) && { currency }),
    ...(session.chargeAmount !== null && { amount: session.chargeAmount }),
    data: { planSlug: session.subscription.plan.slug, reason },
  });
}
