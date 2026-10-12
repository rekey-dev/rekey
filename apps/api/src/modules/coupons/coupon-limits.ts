/**
 * Who may take one more slot on a coupon. Shared by the advisory `validate`
 * and the authoritative `reserveForCheckout`, so the two cannot disagree about
 * who is allowed to check out. Limits are counted across every currency.
 */

import type { Coupon, Prisma } from '@prisma/client';
import type { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';

/**
 * Rows that currently hold a slot against a coupon's GLOBAL ceiling: every
 * settled redemption, plus reservations that have not aged out.
 *
 * `excludeReservationsFor` drops one buyer's own live reservations. Callers
 * about to reserve, or pricing a checkout, for that buyer pass it, since their
 * existing reservation is a slot they already hold and should not count
 * against themselves.
 */
function slotHolderWhere(
  couponId: string,
  now: Date,
  excludeReservationsFor?: string,
): Prisma.CouponRedemptionWhereInput {
  return {
    couponId,
    OR: [
      { status: 'CONFIRMED' },
      {
        status: 'RESERVED',
        expiresAt: { gt: now },
        ...(excludeReservationsFor !== undefined && {
          endUserId: { not: excludeReservationsFor },
        }),
      },
    ],
  };
}

/** Either the module-level client or a `$transaction` one. */
export type CouponLimitsDb = Pick<typeof prisma, 'couponRedemption'> | Prisma.TransactionClient;

/**
 * Refuse unless this buyer may take ONE more slot on this coupon. Shared by the
 * advisory `validate` and the authoritative `reserveForCheckout` so the two can
 * never disagree about who is allowed to check out.
 *
 * Three rules; rule 2 is what stops a reservation from being abused as a
 * denial primitive:
 *
 *   1. The GLOBAL ceiling counts settled redemptions plus everyone ELSE's live
 *      reservations, not this buyer's own.
 *   2. A buyer holds at most `maxRedemptionsPerUser ?? 1` live reservations, so
 *      one account cannot mint unbounded payable discounts or sit on the whole
 *      global ceiling by opening checkouts in a loop.
 *   3. Settled + reserved must stay within `maxRedemptionsPerUser`, so a
 *      reservation is never minted that could not legally settle.
 */
export async function assertLimitsAllowOneMore(
  db: CouponLimitsDb,
  coupon: Coupon,
  endUserId: string,
  displayCode: string,
): Promise<void> {
  const now = new Date();
  await assertCeilingAllowsOneMore(db, coupon, displayCode, endUserId, now);

  const confirmedByUser = await db.couponRedemption.count({
    where: { couponId: coupon.id, endUserId, status: 'CONFIRMED' },
  });
  const reservedByUser = await db.couponRedemption.count({
    where: { couponId: coupon.id, endUserId, status: 'RESERVED', expiresAt: { gt: now } },
  });

  if (
    coupon.maxRedemptionsPerUser !== null &&
    confirmedByUser + reservedByUser >= coupon.maxRedemptionsPerUser
  ) {
    if (confirmedByUser >= coupon.maxRedemptionsPerUser) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_USER_LIMIT_REACHED',
        message: `You have already used coupon "${displayCode}" the maximum number of times.`,
        fix: 'Use a different coupon for this purchase.',
      });
    }
    throw checkoutAlreadyOpen(displayCode);
  }
  // Only bites when the coupon has no per-user limit at all, rule 3 covers
  // the rest.
  if (reservedByUser >= (coupon.maxRedemptionsPerUser ?? 1)) {
    throw checkoutAlreadyOpen(displayCode);
  }
}

/**
 * Rule 1 alone: refuse when the coupon's global ceiling is full. With no
 * buyer named, every live reservation counts, which is what a buyer nobody
 * has identified yet would meet.
 *
 * @example
 * await assertCeilingAllowsOneMore(prisma, coupon, 'LAUNCH');
 */
export async function assertCeilingAllowsOneMore(
  db: CouponLimitsDb,
  coupon: Coupon,
  displayCode: string,
  excludeReservationsFor?: string,
  now: Date = new Date(),
): Promise<void> {
  if (coupon.maxRedemptions === null) return;
  const held = await db.couponRedemption.count({
    where: slotHolderWhere(coupon.id, now, excludeReservationsFor),
  });
  if (held >= coupon.maxRedemptions) {
    throw new RekeyError({
      statusCode: 400,
      code: 'COUPON_REDEMPTION_LIMIT_REACHED',
      message: `Coupon "${displayCode}" has reached its redemption limit.`,
      fix: 'Use a different coupon, this one is fully consumed.',
    });
  }
}

/** The caps an edit asks for. A key left out is not being changed; null removes the cap. */
export interface CouponCapChange {
  maxRedemptions?: number | null | undefined;
  maxRedemptionsPerUser?: number | null | undefined;
}

function belowRedeemed(
  field: 'maxRedemptions' | 'maxRedemptionsPerUser',
  requested: number,
  held: { settled: number; reserved: number },
): RekeyError {
  const total = held.settled + held.reserved;
  const whose = field === 'maxRedemptions' ? 'This coupon' : 'One buyer';
  return new RekeyError({
    statusCode: 409,
    code: 'COUPON_LIMIT_BELOW_REDEEMED',
    message: `${whose} already holds ${total} redemptions (${held.settled} settled, ${held.reserved} held by checkouts still open), so \`${field}\` cannot be ${requested}.`,
    fix:
      `Send \`${field}\` of ${total} or more, or null for no cap.` +
      (held.reserved > 0 ? ' A slot held by an open checkout is given back if that checkout expires unpaid, within 24 hours.' : ''),
    details: { field, requested, redeemed: total, settled: held.settled, reserved: held.reserved },
  });
}

/**
 * Refuse a cap lower than the slots already held against it. Counted as a
 * reservation counts them: settled redemptions plus checkouts still open.
 *
 * The caller holds the coupon row `FOR UPDATE`, the lock every reservation
 * and settlement takes, so no slot is taken between this count and the write.
 *
 * @example
 * await assertCapsCoverRedeemed(tx, coupon.id, { maxRedemptions: 100 });
 */
export async function assertCapsCoverRedeemed(
  tx: Prisma.TransactionClient,
  couponId: string,
  change: CouponCapChange,
  now: Date = new Date(),
): Promise<void> {
  const { maxRedemptions, maxRedemptionsPerUser } = change;
  if (typeof maxRedemptions !== 'number' && typeof maxRedemptionsPerUser !== 'number') return;
  const groups = await tx.couponRedemption.groupBy({
    by: ['endUserId', 'status'],
    where: slotHolderWhere(couponId, now),
    _count: { _all: true },
  });
  const all = { settled: 0, reserved: 0 };
  const byUser = new Map<string, { settled: number; reserved: number }>();
  for (const group of groups) {
    const kind = group.status === 'CONFIRMED' ? 'settled' : 'reserved';
    all[kind] += group._count._all;
    const user = byUser.get(group.endUserId) ?? { settled: 0, reserved: 0 };
    user[kind] += group._count._all;
    byUser.set(group.endUserId, user);
  }
  if (typeof maxRedemptions === 'number' && all.settled + all.reserved > maxRedemptions) {
    throw belowRedeemed('maxRedemptions', maxRedemptions, all);
  }
  if (typeof maxRedemptionsPerUser === 'number') {
    const most = [...byUser.values()].sort((a, b) => b.settled + b.reserved - (a.settled + a.reserved))[0];
    if (most !== undefined && most.settled + most.reserved > maxRedemptionsPerUser) {
      throw belowRedeemed('maxRedemptionsPerUser', maxRedemptionsPerUser, most);
    }
  }
}

/**
 * The buyer's own still-live checkout is holding the slot. Deliberately its own
 * code rather than the limit ones: nothing is exhausted, the discount they
 * already minted is still payable, and telling them to "use a different coupon"
 * would be wrong advice.
 */
function checkoutAlreadyOpen(displayCode: string): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'COUPON_CHECKOUT_ALREADY_OPEN',
    message: `You already have a checkout open with coupon "${displayCode}".`,
    fix: 'Finish paying for that checkout, or wait for it to expire (it holds the discount for up to 24 hours) before starting another with this code.',
  });
}
