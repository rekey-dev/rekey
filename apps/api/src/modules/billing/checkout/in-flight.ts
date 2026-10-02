/**
 * Refuse a new checkout while this buyer's last one for the same plan is
 * already paid at the provider and waiting for its webhook.
 *
 * Between the provider's approval and its activation webhook the local
 * subscription is still PENDING, so nothing else stops a second checkout, and
 * a second provider subscription bills the buyer twice. Two signals count: a
 * session the page already moved to CONFIRMING, and an OPEN PayPal or
 * Razorpay session whose subscription the provider reports as approved (a
 * buyer who paid on the provider's own page, or whose page never reported
 * back).
 *
 * Refused rather than answered with the existing session: the page URL holds
 * a token Rekey keeps only as a hash, so there is no existing URL to return,
 * and a paid checkout needs no page anyway, only the webhook.
 */

import type { Application } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { getProviderForApplication } from '../providers/index.js';
import { stripePaymentInFlight } from './stripe-in-flight.js';
import type { BillingProviderName } from '../credentials.service.js';

/**
 * Provider statuses meaning the buyer has authorised the subscription. A
 * Razorpay `pending` subscription has a mandate whose charge is being retried.
 */
const APPROVED_BY_PROVIDER: Readonly<Partial<Record<BillingProviderName, ReadonlySet<string>>>> = {
  paypal: new Set(['APPROVED', 'ACTIVE']),
  razorpay: new Set(['authenticated', 'active', 'pending']),
};
const PROVIDER_LABEL: Readonly<Record<string, string>> = { paypal: 'PayPal', razorpay: 'Razorpay' };
const MAX_OPEN_SESSIONS_CHECKED = 5;
const EXPIRED_GRACE_MS = 24 * 60 * 60 * 1000;

function inProgress(): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'CHECKOUT_PAYMENT_IN_PROGRESS',
    message: 'A payment for this plan was approved at the payment provider and is waiting to be confirmed.',
    fix: 'Wait a few minutes for the subscription to activate (read it with GET /billing/subscription) instead of starting another checkout, which would bill the buyer twice.',
  });
}

/**
 * @example
 * await assertNoApprovalInFlight({ application, endUserId, planId });
 */
export async function assertNoApprovalInFlight(args: {
  application: Application;
  endUserId: string;
  planId: string;
}): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: {
      applicationId_endUserId_planId: {
        applicationId: args.application.id,
        endUserId: args.endUserId,
        planId: args.planId,
      },
    },
    select: { id: true },
  });
  if (subscription === null) return;
  // Sessions that ran out within the last day count too: a buyer can approve
  // at the provider moments before the link expires (or on the provider's own
  // page after it), and that payment still completes from the webhook.
  const graceFrom = new Date(Date.now() - EXPIRED_GRACE_MS);
  const live = await prisma.checkoutSession.findMany({
    where: {
      subscriptionId: subscription.id,
      kind: 'RECURRING',
      status: { in: ['OPEN', 'CONFIRMING', 'EXPIRED'] },
      expiresAt: { gt: graceFrom },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, provider: true, providerSessionId: true, metadata: true },
  });
  if (live.some((s) => s.status === 'CONFIRMING')) throw inProgress();
  if (await stripePaymentInFlight(args.application, live)) throw inProgress();

  for (const [provider, approved] of Object.entries(APPROVED_BY_PROVIDER) as Array<[BillingProviderName, ReadonlySet<string>]>) {
    const open = live.filter((s) => s.provider === provider).slice(0, MAX_OPEN_SESSIONS_CHECKED);
    if (open.length > 0) await assertNoneApprovedAt(args.application, provider, approved, open);
  }
}

async function assertNoneApprovedAt(
  application: Application,
  providerName: BillingProviderName,
  approved: ReadonlySet<string>,
  sessions: Array<{ id: string; providerSessionId: string }>,
): Promise<void> {
  const provider = await getProviderForApplication(application, providerName);
  const read = provider.getSubscription?.bind(provider);
  if (!read) return;
  // At most MAX_OPEN_SESSIONS_CHECKED reads, in parallel. A failed read
  // refuses: a provider that cannot be reached would fail the new checkout at
  // creation anyway, and guessing "not paid" can bill twice.
  const snapshots = await Promise.all(sessions.map((session) => read(session.providerSessionId))).catch(() => {
    throw new RekeyError({
      statusCode: 503,
      code: 'CHECKOUT_PAYMENT_STATUS_UNAVAILABLE',
      message: `${PROVIDER_LABEL[providerName] ?? providerName} could not be asked whether an earlier checkout for this plan was paid.`,
      fix: 'Retry in a minute.',
    });
  });
  const paid = sessions.find((_, i) => {
    const snapshot = snapshots[i];
    return snapshot !== null && snapshot !== undefined && approved.has(snapshot.status);
  });
  if (paid === undefined) return;
  await prisma.checkoutSession.updateMany({
    where: { id: paid.id, status: { in: ['OPEN', 'EXPIRED'] } },
    data: { status: 'CONFIRMING' },
  });
  throw inProgress();
}
