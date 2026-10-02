/**
 * The Stripe half of the in-flight guard: has an earlier Stripe checkout for
 * this plan already been paid, or committed to a bank debit that is still
 * settling? Stripe reports both as a `complete` Checkout Session, and both
 * complete from Stripe's webhook later, so a second checkout now would bill
 * the buyer twice.
 */

import type { Application, CheckoutSession } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { getProviderForApplication } from '../providers/index.js';
import { PAYMENT_FAILED_AT } from '../webhooks/apply-checkout-payment-failed.js';

const MAX_SESSIONS_CHECKED = 5;

type Row = Pick<CheckoutSession, 'id' | 'status' | 'provider' | 'providerSessionId' | 'metadata'>;

/** Stripe still calls such a session `complete`, but its bank debit failed and the webhook closed it. */
function paymentFailed(row: Row): boolean {
  return (row.metadata as Record<string, unknown> | null)?.[PAYMENT_FAILED_AT] !== undefined;
}

function statusUnavailable(): RekeyError {
  return new RekeyError({
    statusCode: 503,
    code: 'CHECKOUT_PAYMENT_STATUS_UNAVAILABLE',
    message: 'Stripe could not be asked whether an earlier checkout for this plan was paid.',
    fix: 'Retry in a minute.',
  });
}

/**
 * True when one of these OPEN or recently EXPIRED Stripe rows is `complete`
 * at Stripe; that row is moved to CONFIRMING so the next check needs no call.
 * A failed read refuses rather than guesses "not paid".
 *
 * @example
 * if (await stripePaymentInFlight(application, rows)) throw inProgress();
 */
export async function stripePaymentInFlight(application: Application, rows: readonly Row[]): Promise<boolean> {
  const candidates = rows
    .filter((r) => r.provider === 'stripe' && (r.status === 'OPEN' || r.status === 'EXPIRED') && !paymentFailed(r))
    .slice(0, MAX_SESSIONS_CHECKED);
  if (candidates.length === 0) return false;
  // Credentials removed since: nothing can be asked, and a guard that refused
  // here would block this buyer's checkouts at every other provider too. Any
  // other failure to reach Stripe refuses, like a failed read.
  const configured = await prisma.billingCredentials.findUnique({
    where: { applicationId_provider: { applicationId: application.id, provider: 'stripe' } },
    select: { id: true },
  });
  if (configured === null) return false;
  const provider = await getProviderForApplication(application, 'stripe').catch(() => {
    throw statusUnavailable();
  });
  const read = provider.getCheckoutSession?.bind(provider);
  if (!read) return false;
  const snapshots = await Promise.all(candidates.map((row) => read(row.providerSessionId))).catch(() => {
    throw statusUnavailable();
  });
  const paid = candidates.find((_, i) => snapshots[i]?.status === 'complete');
  if (paid === undefined) return false;
  await prisma.checkoutSession.updateMany({
    where: { id: paid.id, status: { in: ['OPEN', 'EXPIRED'] } },
    data: { status: 'CONFIRMING' },
  });
  return true;
}
