/**
 * The billing log's record of what happens to a coupon: created, changed,
 * redeemed, refused.
 */

import type { Prisma } from '@prisma/client';
import {
  recordBillingEvent,
  recordDiagnosticBillingEvent,
  recordMoneyPathBillingEvent,
} from '../billing-log/index.js';
import { termsOf, type CouponRecord } from './coupon-terms.js';

type Tx = Prisma.TransactionClient;

/** Who changed a coupon. Left out, the change is the system's (the super-admin key). */
export type CouponActor = { operatorId: string } | undefined;

function actorOf(actor: CouponActor) {
  return actor === undefined ? ({ type: 'system' } as const) : ({ type: 'operator', id: actor.operatorId } as const);
}

function loggedTerms(coupon: CouponRecord) {
  return {
    active: coupon.active,
    ...termsOf(coupon),
    planSlugs: [...coupon.planSlugs].sort(),
    endsAt: coupon.endsAt?.toISOString() ?? null,
    maxRedemptions: coupon.maxRedemptions,
    maxRedemptionsPerUser: coupon.maxRedemptionsPerUser,
  };
}

/** Written in the transaction that creates the coupon. */
export async function recordCouponCreated(tx: Tx, coupon: CouponRecord, actor: CouponActor): Promise<void> {
  await recordBillingEvent(tx, {
    type: 'coupon.created',
    applicationId: coupon.applicationId,
    actor: actorOf(actor),
    couponId: coupon.id,
    data: { code: coupon.code, discountType: coupon.discountType, terms: loggedTerms(coupon) },
  });
}

/**
 * Written in the transaction that changes the coupon, with what it was
 * before. Returns false, and writes nothing, when the call changed nothing.
 */
export async function recordCouponChanged(
  tx: Tx,
  before: CouponRecord,
  after: CouponRecord,
  actor: CouponActor,
): Promise<boolean> {
  const [was, is] = [loggedTerms(before), loggedTerms(after)];
  if (JSON.stringify(was) === JSON.stringify(is)) return false;
  await recordBillingEvent(tx, {
    type: 'coupon.changed',
    applicationId: after.applicationId,
    actor: actorOf(actor),
    couponId: after.id,
    data: { code: after.code, discountType: after.discountType, before: was, after: is },
  });
  return true;
}

export interface RedeemedPrice {
  planId: string;
  planSlug: string;
  planPriceId: string | null;
  currency: string;
  amount: number;
}

/**
 * Written in the transaction that settles the redemption. The purchase has
 * already been paid for, so an event its schema refuses is set aside and
 * never fails the settlement.
 */
export async function recordCouponRedeemed(
  tx: Tx,
  args: {
    coupon: { id: string; applicationId: string; code: string };
    endUserId: string;
    subscriptionId: string | null;
    paymentId: string | null;
    discountAmount: number;
    price: RedeemedPrice;
  },
): Promise<void> {
  const { coupon, price } = args;
  await recordMoneyPathBillingEvent(tx, {
    type: 'coupon.redeemed',
    applicationId: coupon.applicationId,
    actor: { type: 'end_user', id: args.endUserId },
    endUserId: args.endUserId,
    couponId: coupon.id,
    ...(args.subscriptionId !== null && { subscriptionId: args.subscriptionId }),
    ...(args.paymentId !== null && { paymentId: args.paymentId }),
    planId: price.planId,
    ...(price.planPriceId !== null && { planPriceId: price.planPriceId }),
    currency: price.currency,
    amount: args.discountAmount,
    data: {
      code: coupon.code,
      planSlug: price.planSlug,
      discountAmount: args.discountAmount,
      priceCharged: { planPriceId: price.planPriceId, currency: price.currency, amount: price.amount },
    },
  });
}

/**
 * Record that a known coupon was refused, best-effort. A refusal has no
 * transaction. Anything that goes wrong here is a rejection of the returned
 * promise, never a synchronous throw, so a caller that does not await it
 * handles it with a `catch`.
 *
 * A code that matches no coupon is not recorded: anyone with a session can
 * send any string, and the log is for what happened to the operator's coupons.
 */
export async function recordCouponRefused(args: {
  coupon: { id: string; applicationId: string; code: string };
  endUserId?: string | undefined;
  planId?: string | undefined;
  planSlug: string | null;
  reasonCode: string;
  chargedCurrency: string | null;
}): Promise<void> {
  return recordDiagnosticBillingEvent({
    type: 'coupon.refused',
    applicationId: args.coupon.applicationId,
    actor: args.endUserId === undefined ? { type: 'system' } : { type: 'end_user', id: args.endUserId },
    ...(args.endUserId !== undefined && { endUserId: args.endUserId }),
    couponId: args.coupon.id,
    ...(args.planId !== undefined && { planId: args.planId }),
    ...(args.chargedCurrency !== null && { currency: args.chargedCurrency }),
    data: {
      code: args.coupon.code,
      planSlug: args.planSlug,
      reasonCode: args.reasonCode,
      chargedCurrency: args.chargedCurrency,
    },
  });
}
