/**
 * Refuse a new checkout while this buyer's last one for the same plan is
 * already paid at PayPal and waiting for its webhook.
 *
 * Between PayPal's approval and `BILLING.SUBSCRIPTION.ACTIVATED` the local
 * subscription is still PENDING, so nothing else stops a second checkout, and
 * a second PayPal subscription bills the buyer twice. Two signals count: a
 * session the page already moved to CONFIRMING, and an OPEN PayPal session
 * whose subscription PayPal reports APPROVED or ACTIVE (a buyer who approved
 * on PayPal's own page, or whose page never reported back).
 *
 * Refused rather than answered with the existing session: the page URL holds
 * a token Rekey keeps only as a hash, so there is no existing URL to return,
 * and a paid checkout needs no page anyway, only the webhook.
 */

import type { Application } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { getProviderForApplication } from '../providers/index.js';

const APPROVED = new Set(['APPROVED', 'ACTIVE']);
const MAX_OPEN_SESSIONS_CHECKED = 5;
const EXPIRED_GRACE_MS = 24 * 60 * 60 * 1000;

function inProgress(): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'CHECKOUT_PAYMENT_IN_PROGRESS',
    message: 'A payment for this plan was approved at PayPal and is waiting to be confirmed.',
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
  // at PayPal moments before the link expires (or on PayPal's own page after
  // it), and that payment still completes from the webhook.
  const graceFrom = new Date(Date.now() - EXPIRED_GRACE_MS);
  const live = await prisma.checkoutSession.findMany({
    where: {
      subscriptionId: subscription.id,
      kind: 'RECURRING',
      status: { in: ['OPEN', 'CONFIRMING', 'EXPIRED'] },
      expiresAt: { gt: graceFrom },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, provider: true, providerSessionId: true },
  });
  if (live.some((s) => s.status === 'CONFIRMING')) throw inProgress();

  const openPaypal = live.filter((s) => s.provider === 'paypal').slice(0, MAX_OPEN_SESSIONS_CHECKED);
  if (openPaypal.length === 0) return;
  const provider = await getProviderForApplication(args.application, 'paypal');
  if (!provider.getSubscription) return;
  for (const session of openPaypal) {
    // A failed read refuses: PayPal being unreachable would fail the new
    // checkout at creation anyway, and guessing "not paid" can bill twice.
    const snapshot = await provider.getSubscription(session.providerSessionId).catch(() => {
      throw new RekeyError({
        statusCode: 503,
        code: 'CHECKOUT_PAYMENT_STATUS_UNAVAILABLE',
        message: 'PayPal could not be asked whether an earlier checkout for this plan was paid.',
        fix: 'Retry in a minute.',
      });
    });
    if (snapshot !== null && APPROVED.has(snapshot.status)) {
      await prisma.checkoutSession.updateMany({
        where: { id: session.id, status: { in: ['OPEN', 'EXPIRED'] } },
        data: { status: 'CONFIRMING' },
      });
      throw inProgress();
    }
  }
}
