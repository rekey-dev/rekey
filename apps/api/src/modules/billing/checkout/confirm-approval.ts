/**
 * The checkout page's "the provider said yes", for every provider: check it
 * with the provider and move the session from OPEN to CONFIRMING. It
 * activates and captures nothing; only the provider's signed webhook does.
 *
 * What is the same for every provider lives here:
 *   - a session that is not OPEN, or belongs to another provider, is refused;
 *   - after five counted refusals the session refuses more, so a caller
 *     holding the token cannot keep guessing;
 *   - every refusal is recorded as a security event;
 *   - the move is a compare-and-set, so concurrent confirmations make one
 *     transition and the rest see it.
 * What the provider's own record must say is the verifier's job.
 */

import type { Application, CheckoutSession } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { recordSecurityEvent } from '../../../lib/security-events.js';
import { settleSessionForToken } from './sessions.service.js';

export const MAX_REFUSED_CONFIRMATIONS = 5;

export type ConfirmationSession = CheckoutSession & { application: Application };

/**
 * Why the provider does not confirm. `counted: false` is for answers that are
 * not the buyer's doing (the session's own payment not approved yet, or Rekey
 * unable to ask), which must not lock out the genuine approval that follows.
 * `message` and `fix` replace the verifier's default wording.
 */
export interface Refusal {
  reason: string;
  counted: boolean;
  message?: string;
  fix?: string;
}

export interface ApprovalVerifier {
  provider: string;
  /** The default wording of CHECKOUT_CONFIRMATION_REFUSED for this provider. */
  refused: { message: string; fix: string };
  /** Ids recorded on the security event, truncated to 64 characters. */
  eventIds: Record<string, string>;
  /**
   * When set, the move to CONFIRMING also requires the row to still name this
   * provider session, and a row that moved on meanwhile is refused. For a
   * provider whose session can be replaced while it is being asked (Stripe's
   * hosted fallback).
   */
  providerSessionId?: string;
  /** Null when the provider confirms; may act on the provider (a capture) before answering. */
  verify(session: ConfirmationSession): Promise<Refusal | null>;
}

type Outcome = { status: 'confirming' | 'complete' };

function refusedCount(session: CheckoutSession): number {
  const value = (session.metadata as Record<string, unknown>).refusedConfirmations;
  return typeof value === 'number' ? value : 0;
}

async function refuse(session: ConfirmationSession, refusal: Refusal, verifier: ApprovalVerifier): Promise<RekeyError> {
  // Increment inside the JSON column with one statement, so concurrent
  // refusals cannot lose a count.
  if (refusal.counted) {
    await prisma.$executeRaw`
      UPDATE checkout_sessions
      SET metadata = jsonb_set(metadata, '{refusedConfirmations}', to_jsonb(COALESCE((metadata->>'refusedConfirmations')::int, 0) + 1)),
          updated_at = NOW()
      WHERE id = ${session.id}`;
  }
  const ids = Object.fromEntries(Object.entries(verifier.eventIds).map(([k, v]) => [k, v.slice(0, 64)]));
  void recordSecurityEvent({
    type: 'app.checkout_confirmation_refused',
    actorType: 'system',
    tenantId: session.application.tenantId,
    applicationId: session.applicationId,
    metadata: { checkoutSessionId: session.id, reason: refusal.reason, ...ids },
  });
  return new RekeyError({
    statusCode: 409,
    code: 'CHECKOUT_CONFIRMATION_REFUSED',
    message: refusal.message ?? verifier.refused.message,
    fix: refusal.fix ?? verifier.refused.fix,
  });
}

/**
 * @example
 * await confirmApproval('chk_live_…', razorpayVerifier(response)); // { status: 'confirming' }
 */
export async function confirmApproval(token: string, verifier: ApprovalVerifier): Promise<Outcome> {
  const session = await settleSessionForToken(token);
  if (session.status === 'COMPLETE') return { status: 'complete' };
  if (session.status === 'CONFIRMING') return { status: 'confirming' };
  if (session.status !== 'OPEN' || session.provider !== verifier.provider) {
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

  const refusal = await verifier.verify(session);
  if (refusal !== null) throw await refuse(session, refusal, verifier);

  const pinned = verifier.providerSessionId;
  const moved = await prisma.checkoutSession.updateMany({
    where: { id: session.id, status: 'OPEN', ...(pinned !== undefined && { providerSessionId: pinned }) },
    data: { status: 'CONFIRMING' },
  });
  const now = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: session.id }, select: { status: true } });
  if (now.status === 'COMPLETE') return { status: 'complete' };
  if (pinned !== undefined && moved.count === 0 && now.status !== 'CONFIRMING') {
    throw await refuse(session, { reason: 'session_replaced', counted: false }, verifier);
  }
  return { status: 'confirming' };
}
