/**
 * The payment appliers: a provider said a charge succeeded, or failed.
 *
 * A charge that succeeded is always recorded. What differs is whether it is
 * applied:
 *
 *   - it matches a subscription and passes `judgeCharge`: a VERIFIED payment,
 *     and the subscription's status, period and entitlements follow it;
 *   - it matches no subscription, or fails the judge (another currency, an
 *     amount outside the band, a provider price that is not the plan's): an
 *     UNVERIFIED payment linked to no subscription, an unapplied case for the
 *     operator, and `payment.not_applied` in the billing log. Nothing is
 *     granted for it.
 *
 * The payment row, the subscription change, the billing log events and the
 * outbound webhook rows commit in one transaction. The unique
 * (application_id, provider_payment_id) makes a redelivery roll all of it
 * back, so a replay writes and announces nothing.
 */

import type { Prisma, Subscription } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { entitlementsService } from '../entitlements.service.js';
import { dunningService } from '../dunning.service.js';
import { kickDeliveries } from '../../webhooks/webhook.service.js';
import { openUnappliedPaymentCase } from '../unapplied-payments.service.js';
import { reportingCurrencyOf } from '../reporting-currency.js';
import { snapshotSubscriptionPrice } from '../subscription-snapshot.js';
import { logNotRecorded } from './not-recorded.js';
import {
  logPaymentNotApplied,
  logPaymentRecorded,
  logSubscriptionActivated,
  type LoggedPayment,
  type Origin,
} from '../money-events.js';
import type { PaymentSucceededEvent } from '../providers/module-types.js';
import { enqueuePaymentEvent, enqueueSubscriptionEvent } from './billing-events.js';
import { judgeCharge, type ChargeVerdict, type JudgedPrice } from './charge-check.js';
import {
  clearedOnReactivation,
  findOwnedSubscription,
  localSubscriptionWhere,
  redeemSessionCoupon,
  safeAmount,
  type ApplyContext,
} from './apply-shared.js';

/**
 * Statuses a successful payment moves to ACTIVE: a checkout completing
 * (PENDING) and dunning recovery (PAST_DUE). Never TRIALING, whose first
 * invoice is the trial's own and whose conversion the status mirror reports,
 * and never a terminal status (see transitionAllowed).
 */
const ACTIVATED_BY_PAYMENT: ReadonlySet<Subscription['status']> = new Set(['PENDING', 'PAST_DUE']);

export const LOGGED_PAYMENT = {
  id: true,
  applicationId: true,
  endUserId: true,
  subscriptionId: true,
  planPriceId: true,
  unitAmount: true,
  discountAmount: true,
  amount: true,
  currency: true,
  providerPaymentId: true,
  verification: true,
} as const satisfies Prisma.PaymentSelect;

/** Who an event's writes are attributed to in the billing log: the provider that sent it. */
export function originOf(ev: { providerEventId: string }, ctx: ApplyContext, subscription?: Pick<Subscription, 'provider'> | null): Origin {
  const provider = ctx.provider ?? subscription?.provider ?? null;
  return {
    actor: { type: 'provider', ...(provider !== null && { id: provider }) },
    provider,
    providerEventId: ev.providerEventId,
    log: ctx.log,
  };
}

/** What names a charge, whichever event reported it. */
export type ChargeIdentity = Pick<
  PaymentSucceededEvent,
  'applicationId' | 'providerEventId' | 'providerPaymentId' | 'providerSubscriptionId' | 'description'
>;

/** What the payment row says about the charge. */
export interface ChargeColumns {
  amount: number;
  currency: string;
  verification: 'VERIFIED' | 'UNVERIFIED';
  planPriceId: string | null;
  unitAmount: number | null;
  discountAmount: number;
  subscriptionId: string | null;
  endUserId: string | null;
}

/**
 * Write the SUCCEEDED payment: a new row, or the FAILED row of the same
 * provider payment now that the provider has collected it (Stripe retries the
 * SAME invoice). Null when the row is already SUCCEEDED, which is a replay.
 *
 * @example
 * const payment = await writeSucceededPayment(tx, ev, columns, 'stripe');
 */
export async function writeSucceededPayment(
  tx: Prisma.TransactionClient,
  ev: ChargeIdentity,
  columns: ChargeColumns,
  provider: string | null,
): Promise<LoggedPayment | null> {
  const key = { applicationId: ev.applicationId, providerPaymentId: ev.providerPaymentId };
  // ON CONFLICT DO NOTHING: a plain insert that hit the unique index would
  // abort this transaction, and the FAILED row could not then be promoted in it.
  const created = await tx.payment.createMany({
    data: [
      {
        ...key,
        ...columns,
        status: 'SUCCEEDED',
        // Stored on every payment: it is what lets an unapplied payment be
        // attributed to an end user later.
        providerSubscriptionId: ev.providerSubscriptionId ?? null,
        description: ev.description ?? null,
        provider,
      },
    ],
    skipDuplicates: true,
  });
  if (created.count === 0) {
    const won = await tx.payment.updateMany({
      where: { ...key, status: 'FAILED' },
      data: {
        ...columns,
        status: 'SUCCEEDED',
        ...(ev.providerSubscriptionId && { providerSubscriptionId: ev.providerSubscriptionId }),
        ...(ev.description != null && { description: ev.description }),
      },
    });
    if (won.count !== 1) return null;
  }
  return tx.payment.findFirstOrThrow({ where: key, select: LOGGED_PAYMENT });
}

/**
 * Record a charge that is not applied: UNVERIFIED, linked to no subscription,
 * with the reason in the billing log. Then, after the commit, open the
 * operator's case for it.
 *
 * @example
 * await recordUnappliedCharge(ev, ctx, { amount: 1900, currency: 'USD' }, { reason: 'no_subscription', expected: null, named: null });
 */
export async function recordUnappliedCharge(
  ev: ChargeIdentity,
  ctx: ApplyContext,
  charge: { amount: number; currency: string },
  why: {
    reason: 'currency_mismatch' | 'amount_out_of_band' | 'price_not_on_plan' | 'no_subscription';
    expected: JudgedPrice | null;
    named: Subscription | null;
  },
): Promise<void> {
  const origin = originOf(ev, ctx, why.named);
  const committed = await prisma.$transaction(async (tx) => {
    const payment = await writeSucceededPayment(
      tx,
      ev,
      {
        ...charge,
        verification: 'UNVERIFIED',
        planPriceId: null,
        unitAmount: null,
        discountAmount: 0,
        subscriptionId: null,
        endUserId: why.named?.endUserId ?? null,
      },
      origin.provider ?? null,
    );
    if (payment === null) return null;
    await logPaymentRecorded(tx, payment, origin);
    await logPaymentNotApplied(tx, payment, { reason: why.reason, expected: why.expected, subscriptionId: why.named?.id }, origin);
    return { payment, deliveryIds: await enqueuePaymentEvent(tx, 'payment.succeeded', payment.id) };
  });
  if (committed === null) {
    ctx.log.info({ providerPaymentId: ev.providerPaymentId }, 'payment.succeeded: payment already recorded');
    return;
  }
  kickDeliveries(committed.deliveryIds);
  // Awaited, so the case and the mail exist before the webhook is
  // acknowledged: a provider that gets its 200 never sends this event again.
  await openUnappliedPaymentCase(
    {
      paymentId: committed.payment.id,
      applicationId: ev.applicationId,
      endUserId: why.named?.endUserId ?? null,
      provider: ctx.provider ?? why.named?.provider ?? 'unknown',
      amount: charge.amount,
      currency: charge.currency,
      providerPaymentId: ev.providerPaymentId,
      providerSubscriptionId: ev.providerSubscriptionId ?? null,
      reasonCode: why.reason,
      providerEventId: ev.providerEventId,
    },
    ctx.log,
  );
}

/**
 * The subscription side of a verified payment, inside its transaction: the
 * price a first payment fixes, status, period anchor, the log and the outbox
 * rows. Returns delivery ids.
 */
async function mirrorVerifiedPayment(
  tx: Prisma.TransactionClient,
  payment: LoggedPayment,
  sub: Subscription,
  ev: PaymentSucceededEvent,
  verdict: Extract<ChargeVerdict, { kind: 'apply' }>,
  origin: Origin,
): Promise<string[]> {
  if (verdict.firstPrice !== null) {
    await snapshotSubscriptionPrice(tx, {
      subscriptionId: sub.id,
      planPriceId: verdict.firstPrice.planPriceId,
      unitAmountOverride: verdict.firstPrice.unitAmount,
      // A row with no price takes one only if a checkout has not given it one
      // in the meantime. A price nobody had paid at yet is replaced.
      ...(sub.currency === null && { onlyIfUnpriced: true }),
      logged: { cause: 'first_payment', ...origin },
    });
  }
  // The payment is recorded either way, but a charge arriving against a
  // CANCELED or EXPIRED row does not bring it back to life.
  const activates = ACTIVATED_BY_PAYMENT.has(sub.status);
  const subData = {
    ...(activates && { status: 'ACTIVE' as const }),
    // Forward only: an older invoice delivered late must not pull the period
    // back to a date already past and expire a paying subscriber.
    ...(ev.currentPeriodEnd !== undefined &&
      (sub.currentPeriodEnd === null || ev.currentPeriodEnd > sub.currentPeriodEnd) && {
        currentPeriodEnd: ev.currentPeriodEnd,
      }),
    // A PENDING row going live on its payment is a checkout completing, and a
    // resubscribe reuses the cancelled row, so the old dates go. Not on
    // PAST_DUE: that is dunning recovery, where a cancellation the buyer
    // scheduled is still theirs.
    ...(activates && sub.status === 'PENDING' ? clearedOnReactivation : {}),
  };
  if (Object.keys(subData).length > 0) await tx.subscription.update({ where: { id: sub.id }, data: subData });

  await logPaymentRecorded(tx, payment, origin);
  const ids = await enqueuePaymentEvent(tx, 'payment.succeeded', payment.id);
  if (activates) {
    await logSubscriptionActivated(tx, sub.id, { via: 'provider', trial: false }, origin);
    ids.push(...(await enqueueSubscriptionEvent(tx, 'subscription.activated', sub.id)));
  }
  return ids;
}

/**
 * @example
 * await applyPaymentSucceeded({ type: 'payment.succeeded', providerPaymentId: 'in_1', amount: 1900, currency: 'usd', … }, ctx);
 */
export async function applyPaymentSucceeded(ev: PaymentSucceededEvent, ctx: ApplyContext): Promise<void> {
  const amount = safeAmount(ev.amount, ctx.log, { providerPaymentId: ev.providerPaymentId, field: 'amount_paid' });
  if (amount === null) {
    await logNotRecorded(
      {
        applicationId: ev.applicationId,
        providerEventId: ev.providerEventId,
        providerPaymentId: ev.providerPaymentId,
        kind: 'charge',
        reason: 'amount_not_storable',
        reportedAmount: ev.reportedAmount ?? ev.amount,
        currency: ev.currency,
      },
      ctx,
    );
    ctx.note?.(
      `payment.succeeded: payment "${ev.providerPaymentId}" carried an amount Rekey cannot store ` +
        '(not a whole number of the smallest unit, negative, or above 2,147,483,647), so no payment was recorded. ' +
        'The money is at the provider; reconcile it there.',
    );
    return;
  }

  const where = localSubscriptionWhere(ev.applicationId, ev.providerSubscriptionId, ev.checkoutSessionId);
  const matched = where ? await findOwnedSubscription(where, ctx) : null;
  if (!matched && ev.deferUntilLinked) {
    // Thrown before anything is written, so the receipt stays unprocessed and
    // the provider's redelivery, after the checkout links the subscription,
    // records it against the right row instead of opening an unapplied case.
    throw new Error(
      `payment ${ev.providerPaymentId} pays the first period of provider subscription ` +
        `${ev.providerSubscriptionId ?? '(none)'}, whose checkout has not been applied yet; retry later.`,
    );
  }
  if (!matched) {
    // `requireLocalSubscription` is not honoured for a succeeded payment: an
    // unlinked failure record buys nothing, but money that arrived and left
    // no trace cannot be refunded by an operator who cannot see it.
    const currency = (ev.currency ?? (await reportingCurrencyOf(ev.applicationId))).toUpperCase();
    await recordUnappliedCharge(ev, ctx, { amount, currency }, { reason: 'no_subscription', expected: null, named: null });
    return;
  }

  const verdict = await judgeCharge(
    matched,
    {
      amount,
      currency: ev.currency,
      providerPaymentId: ev.providerPaymentId,
      providerPriceId: ev.providerPriceId,
      providerSessionId: ev.checkoutSessionId,
    },
    ctx,
  );
  if (verdict.kind === 'not_applied') {
    ctx.note?.(`payment.succeeded: ${verdict.note}`);
    await recordUnappliedCharge(
      ev,
      ctx,
      { amount, currency: verdict.currency },
      { reason: verdict.reason, expected: verdict.expected, named: matched },
    );
    return;
  }

  const origin = originOf(ev, ctx, matched);
  const committed = await prisma.$transaction(async (tx) => {
    const payment = await writeSucceededPayment(
      tx,
      ev,
      {
        amount,
        currency: verdict.currency,
        verification: 'VERIFIED',
        planPriceId: verdict.price?.planPriceId ?? null,
        unitAmount: verdict.price?.amount ?? null,
        discountAmount: verdict.discountAmount,
        subscriptionId: matched.id,
        endUserId: matched.endUserId,
      },
      origin.provider ?? null,
    );
    if (payment === null) return null;
    return { payment, deliveryIds: await mirrorVerifiedPayment(tx, payment, matched, ev, verdict, origin) };
  });
  let recorded: { id: string } | null = committed?.payment ?? null;
  if (committed === null) {
    ctx.log.info({ providerPaymentId: ev.providerPaymentId }, 'payment.succeeded: payment already recorded');
    // A replay grants again only what its first delivery was entitled to: the
    // payment on file must be verified and this subscription's. One that was
    // recorded unapplied stays unapplied until an operator resolves its case.
    const onFile = await prisma.payment.findUnique({
      where: { applicationId_providerPaymentId: { applicationId: ev.applicationId, providerPaymentId: ev.providerPaymentId } },
      select: { id: true, verification: true, subscriptionId: true },
    });
    if (onFile === null || onFile.verification !== 'VERIFIED' || onFile.subscriptionId !== matched.id) return;
    recorded = onFile;
  } else {
    kickDeliveries(committed.deliveryIds);
  }

  // Coupon redemption, post-commit, keyed on the session the EVENT names and
  // never on whichever session the row issued most recently: a renewal names
  // no session and redeems nothing. Idempotent per (coupon, session).
  if (ev.checkoutSessionId) {
    await redeemSessionCoupon(
      { subscription: matched, checkoutSessionId: ev.checkoutSessionId, paymentId: committed?.payment.id },
      ctx,
    );
  }

  // Money moved for this subscription, whatever the status-mirror ordering:
  // an OPEN dunning case is now recovered (no-op when none is open).
  await dunningService.recoverForSubscription(matched.id);

  // Re-provision on every verified payment, replays included: provisioning is
  // idempotent per (subscription, period), and a delivery that committed the
  // payment and then failed here is retried by the provider. The FIRST
  // payment provisions the period checkout already did, so it anchors on
  // 'initial'; a one-off plan collides on the purchase instead.
  const fresh = await prisma.subscription.findUnique({ where: { id: matched.id } });
  if (fresh) {
    await entitlementsService.provision({
      subscription: fresh,
      log: ctx.log,
      firstPeriod: ev.firstPeriod,
      ...(ev.checkoutSessionId !== undefined && { purchaseRef: ev.checkoutSessionId }),
      ...(recorded !== null && { paymentId: recorded.id }),
    });
  }
}
