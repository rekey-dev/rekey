/**
 * The checkout page's "PayPal said yes": verify it with PayPal and move the
 * session from OPEN to CONFIRMING. It activates nothing. Only PayPal's signed
 * `BILLING.SUBSCRIPTION.ACTIVATED` webhook does, through the unchanged applier.
 *
 * What a caller holding the token could try, and what stops it:
 *   - a subscription id from another checkout, Application or mode: the id
 *     must be the one this session created, and PayPal's own record of it must
 *     name this session's plan and `${applicationId}:${endUserId}`;
 *   - an id the buyer never approved: PayPal must report APPROVED or ACTIVE;
 *   - a sandbox id after the credentials moved to live: the session's mode is
 *     checked first, and PayPal is read through the current credential set;
 *   - hammering: after five refused confirmations the session refuses more;
 *   - racing: the move is a compare-and-set, so concurrent confirmations make
 *     one transition and the rest see it.
 */

import type { CheckoutSession } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { recordSecurityEvent } from '../../../lib/security-events.js';
import { getProviderForApplication } from '../providers/index.js';
import type { EmbeddedSessionMetadata } from './sessions.service.js';
import { settleSessionForToken } from './sessions.service.js';

export const MAX_REFUSED_CONFIRMATIONS = 5;
const APPROVED_STATUSES = new Set(['APPROVED', 'ACTIVE']);

type Outcome = { status: 'confirming' | 'complete' };

function refusedCount(session: CheckoutSession): number {
  const value = (session.metadata as Record<string, unknown>).refusedConfirmations;
  return typeof value === 'number' ? value : 0;
}

async function refuse(
  session: CheckoutSession & { application: { tenantId: string } },
  reason: string,
  providerSubscriptionId: string,
  countsTowardLimit = true,
): Promise<RekeyError> {
  // Increment inside the JSON column with one statement, so concurrent
  // refusals cannot lose a count.
  if (countsTowardLimit) {
    await prisma.$executeRaw`
      UPDATE checkout_sessions
      SET metadata = jsonb_set(metadata, '{refusedConfirmations}', to_jsonb(COALESCE((metadata->>'refusedConfirmations')::int, 0) + 1)),
          updated_at = NOW()
      WHERE id = ${session.id}`;
  }
  void recordSecurityEvent({
    type: 'app.checkout_confirmation_refused',
    actorType: 'system',
    tenantId: session.application.tenantId,
    applicationId: session.applicationId,
    metadata: { checkoutSessionId: session.id, reason, providerSubscriptionId: providerSubscriptionId.slice(0, 64) },
  });
  return new RekeyError({
    statusCode: 409,
    code: 'CHECKOUT_CONFIRMATION_REFUSED',
    message: 'PayPal does not confirm this approval for this checkout.',
    fix: 'Approve the payment again with the PayPal button on this page, or continue on PayPal.',
  });
}

/**
 * @example
 * await confirmPaypalApproval('chk_live_…', 'I-BW452GLLEP1G'); // { status: 'confirming' }
 */
export async function confirmPaypalApproval(token: string, subscriptionId: string): Promise<Outcome> {
  const session = await settleSessionForToken(token);
  if (session.status === 'COMPLETE') return { status: 'complete' };
  if (session.status === 'CONFIRMING') return { status: 'confirming' };
  if (session.status !== 'OPEN' || session.provider !== 'paypal') {
    throw new RekeyError({
      statusCode: 409,
      code: 'CHECKOUT_SESSION_EXPIRED',
      message: 'This checkout can no longer be paid here.',
      fix: 'Return to the app you were buying in and start the checkout again.',
    });
  }
  if (refusedCount(session) >= MAX_REFUSED_CONFIRMATIONS) {
    throw new RekeyError({
      statusCode: 409,
      code: 'CHECKOUT_CONFIRMATION_LIMIT',
      message: 'This checkout has refused too many confirmations.',
      fix: 'Return to the app you were buying in and start the checkout again.',
    });
  }
  if (subscriptionId !== session.providerSessionId) {
    throw await refuse(session, 'subscription_id_mismatch', subscriptionId);
  }

  const provider = await getProviderForApplication(session.application, 'paypal');
  if (!provider.getSubscription) throw await refuse(session, 'provider_cannot_verify', subscriptionId);
  const snapshot = await provider.getSubscription(subscriptionId);
  const meta = session.metadata as unknown as EmbeddedSessionMetadata;
  const expectedCustomId = `${session.applicationId}:${session.endUserId}`;
  if (snapshot === null || snapshot.id !== subscriptionId) {
    throw await refuse(session, 'unknown_at_paypal', subscriptionId);
  }
  if (snapshot.customId !== expectedCustomId) throw await refuse(session, 'custom_id_mismatch', subscriptionId);
  if (snapshot.planId !== meta.providerPlanId) throw await refuse(session, 'plan_mismatch', subscriptionId);
  // Not counted toward the limit: this is the session's own subscription, just
  // not approved (yet), which is what a cancelled PayPal window or a refresh
  // of the return URL looks like. Counting it would let those lock out the
  // genuine approval that follows.
  if (!APPROVED_STATUSES.has(snapshot.status)) {
    throw await refuse(session, `status_${snapshot.status}`, subscriptionId, false);
  }

  await prisma.checkoutSession.updateMany({
    where: { id: session.id, status: 'OPEN' },
    data: { status: 'CONFIRMING' },
  });
  const now = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: session.id }, select: { status: true } });
  return { status: now.status === 'COMPLETE' ? 'complete' : 'confirming' };
}
