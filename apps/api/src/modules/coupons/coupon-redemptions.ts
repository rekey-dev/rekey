/**
 * A coupon's redemptions: the slot a checkout reserves and the settlement
 * that confirms it. See coupons.service.ts for why redemption is two-phase.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { assertLimitsAllowOneMore } from './coupon-limits.js';
import { recordCouponRedeemed, type RedeemedPrice } from './coupon-events.js';

/**
 * How long a checkout reservation holds its slot against the coupon's limits.
 *
 * Pinned to the longest a provider checkout session stays payable: Stripe
 * Checkout Sessions expire after 24 hours, PayPal orders and Razorpay payment
 * links are in the same range. Shorter would let the slot free up while the
 * discount is still chargeable. Longer would let an unreleased reservation
 * become its own denial-of-discount primitive.
 */
export const RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Why `redeemForCheckout` did or did not write a row. See the method. */
export type RedemptionOutcome =
  /** A new `CouponRedemption` row was written. */
  | { recorded: true }
  /** This (coupon, checkout session) was already redeemed, replay, or the
   *  other applier got there first. Nothing to do, and not an error. */
  | { recorded: false; reason: 'already-redeemed' }
  /** A global / per-user limit is now exhausted. The purchase still stands;
   *  the operator's coupon books simply cannot record this one. */
  | { recorded: false; reason: 'limit-reached'; code: string; message: string };

type Tx = Prisma.TransactionClient;

/**
 * The price a redemption was taken off, for the billing log: the price row
 * the checkout reserved against, else what the subscription pays. Null when
 * neither is known, which is a settlement that named no subscription and had
 * no reservation.
 */
async function redeemedPrice(
  tx: Tx,
  planPriceId: string | null,
  subscriptionId: string | null,
): Promise<RedeemedPrice | null> {
  if (planPriceId !== null) {
    const row = await tx.planPrice.findUnique({
      where: { id: planPriceId },
      select: { id: true, currency: true, amount: true, plan: { select: { id: true, slug: true } } },
    });
    if (row !== null) {
      return { planId: row.plan.id, planSlug: row.plan.slug, planPriceId: row.id, currency: row.currency.toUpperCase(), amount: row.amount };
    }
  }
  if (subscriptionId === null) return null;
  const subscription = await tx.subscription.findUnique({
    where: { id: subscriptionId },
    select: { planPriceId: true, currency: true, unitAmount: true, plan: { select: { id: true, slug: true } } },
  });
  if (subscription === null || subscription.currency === null || subscription.unitAmount === null) return null;
  return {
    planId: subscription.plan.id,
    planSlug: subscription.plan.slug,
    planPriceId: subscription.planPriceId,
    currency: subscription.currency.toUpperCase(),
    amount: subscription.unitAmount,
  };
}

export const couponRedemptions = {
  /**
   * Take a RESERVED slot on a coupon for a checkout that is about to be
   * created, and return its id. Throws the same `RekeyError` codes `validate`
   * does when the coupon has no slot left for this buyer.
   *
   * THIS is the authoritative limit check, not `validate`: it runs inside a
   * transaction that holds the coupon row `FOR UPDATE`, so concurrent checkouts
   * on the same coupon serialise here rather than all reading the same count,
   * whatever currency each of them charges.
   *
   * Called BEFORE the provider round-trip, before a session id exists. The
   * provider mints the discount inside `createCheckoutSession`, so a slot
   * taken afterwards would be taken after the money was already discountable.
   * `bindReservationToSession` fills the session in once the provider answers;
   * `releaseReservation` gives the slot back when it doesn't.
   */
  async reserveForCheckout(args: {
    couponId: string;
    applicationId: string;
    endUserId: string;
    /** Display form of the code, for the refusal messages. */
    code: string;
    /** Discount in the smallest currency unit, as resolved at checkout time. */
    discountAmount: number;
    /** The currency the checkout charges, which `discountAmount` is in. */
    currency: string;
    /** The price row the checkout charges. Null for a plan with no flat price. */
    planPriceId: string | null;
  }): Promise<{ reservationId: string; expiresAt: Date }> {
    return prisma.$transaction(async (tx) => {
      // Same pessimistic lock the settle path takes, so a reservation and a
      // settlement on one coupon can never interleave between the count and
      // the write.
      await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${args.couponId} FOR UPDATE`;
      const coupon = await tx.coupon.findUniqueOrThrow({ where: { id: args.couponId } });

      // Drop this coupon's aged-out reservations first, so the counts below
      // are about live slots and the table does not accumulate rows that mean
      // nothing. Safe to do here and nowhere else: every writer of a RESERVED
      // row holds the same coupon lock.
      await tx.couponRedemption.deleteMany({
        where: { couponId: coupon.id, status: 'RESERVED', expiresAt: { lte: new Date() } },
      });

      await assertLimitsAllowOneMore(tx, coupon, args.endUserId, args.code);

      const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
      const row = await tx.couponRedemption.create({
        data: {
          couponId: args.couponId,
          applicationId: args.applicationId,
          endUserId: args.endUserId,
          // Filled by bindReservationToSession once the provider hands one
          // back. NULLs are distinct in Postgres, so the unique
          // (couponId, checkoutSessionId) index tolerates the gap.
          checkoutSessionId: null,
          discountAmount: args.discountAmount,
          currency: args.currency.toUpperCase(),
          planPriceId: args.planPriceId,
          status: 'RESERVED',
          expiresAt,
        },
        select: { id: true },
      });
      return { reservationId: row.id, expiresAt };
    });
  },

  /**
   * Point a reservation at the checkout session the provider just created.
   * From here the row is findable by (coupon, session), which is how the
   * webhook appliers settle it.
   */
  async bindReservationToSession(reservationId: string, checkoutSessionId: string): Promise<void> {
    await prisma.couponRedemption.update({
      where: { id: reservationId },
      data: { checkoutSessionId },
    });
  },

  /**
   * Hand a reservation's slot back. Called when the checkout that took it never
   * happened, the provider call threw, so no discount was ever minted and
   * nothing should be holding a slot for the next 24 hours.
   *
   * Best-effort by construction: the caller is already unwinding a failure, and
   * a reservation that survives is corrected by its own expiry rather than by
   * turning one error into two.
   */
  async releaseReservation(reservationId: string): Promise<void> {
    await prisma.couponRedemption.deleteMany({
      where: { id: reservationId, status: 'RESERVED' },
    });
  },

  /**
   * Settle the redemption of a coupon against ONE completed checkout session,
   * with the limit re-check. The earlier `validate` call is an *advisory* gate
   * (TOCTOU-vulnerable); the reservation is the binding one. Runs in a
   * transaction with a row-level lock on the coupon row so two concurrent
   * webhook handlers cannot both pass the count check.
   *
   * ## Confirming beats counting
   *
   * When the session has a RESERVED row, this only flips it to CONFIRMED, no
   * limit check, deliberately: the slot was taken when the discount was
   * minted, and re-testing a ceiling this row is already counted in would
   * refuse a purchase the buyer was entitled to make. That includes a
   * reservation that has aged out, since the money still moved.
   *
   * The no-reservation path (a provider flow that never went through our
   * checkout, or a reservation swept between binding and settlement) keeps the
   * historical behaviour: count CONFIRMED rows, and report rather than throw.
   *
   * ## Idempotent, by (coupon, checkout session)
   *
   * Both the checkout applier and the payment applier call this for the same
   * purchase, and the provider replays webhooks freely, so this runs several
   * times per sale by design and exactly one row results. The grain is the
   * checkout session rather than the subscription because a subscription row
   * is reused: a repeat one-time purchase is a second discount and must be a
   * second redemption, while a recurring subscription's renewals reuse the
   * session that bought the single discounted invoice and must not be.
   *
   * ## Never throws for a business reason
   *
   * Called from webhook appliers that have just written, or are about to
   * write, a `Payment` row. A redemption that cannot be recorded (coupon
   * exhausted, or a per-user limit the renewal now exceeds) is a bookkeeping
   * fact, not a reason to fail the delivery: throwing here previously rolled
   * the payment transaction back, so the money moved at the provider but the
   * local `Payment` row, subscription mirroring, and entitlements never
   * happened, and the provider retried the poisoned event until it gave up.
   * The outcome is returned so the caller can log it; genuine infrastructure
   * failures still throw.
   *
   * Deliberately NOT given an `outerTx` parameter: running inside the caller's
   * transaction is what let a redemption failure undo a payment, and a
   * Postgres transaction that already hit a constraint violation cannot be
   * continued anyway.
   */
  async redeemForCheckout(args: {
    couponId: string;
    applicationId: string;
    endUserId: string;
    checkoutSessionId: string;
    subscriptionId?: string;
    paymentId?: string;
    /** Discount in the smallest currency unit, stamped onto the row. */
    discountAmount?: number;
    /** The currency `discountAmount` is in. A reservation that already names one keeps it; left out, it is the price's. */
    currency?: string;
  }): Promise<RedemptionOutcome> {
    try {
      return await prisma.$transaction(async (tx): Promise<RedemptionOutcome> => {
        // Pessimistic lock on the coupon row, serialises every concurrent
        // redemption attempt against the same coupon, so the counts read
        // below are authoritative for the duration of this transaction.
        await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${args.couponId} FOR UPDATE`;

        const coupon = await tx.coupon.findUniqueOrThrow({ where: { id: args.couponId } });
        const subscriptionId = args.subscriptionId ?? null;

        // Checked BEFORE the limits, and inside the lock: an already-settled
        // session is a no-op even when the coupon is now exhausted, so a
        // replayed webhook cannot be reported as a limit failure. A RESERVED
        // row is this sale's own slot, confirm it rather than count it.
        const existing = await tx.couponRedemption.findFirst({
          where: { couponId: coupon.id, checkoutSessionId: args.checkoutSessionId },
          select: { id: true, status: true, currency: true, planPriceId: true, discountAmount: true },
        });
        if (existing?.status === 'CONFIRMED') return { recorded: false, reason: 'already-redeemed' };

        // The price the checkout reserved against says what was charged. A
        // settlement with no reservation takes it from the subscription.
        const price = await redeemedPrice(tx, existing?.planPriceId ?? null, subscriptionId);
        const currency = (existing?.currency ?? args.currency ?? price?.currency)?.toUpperCase() ?? null;
        const discountAmount = args.discountAmount ?? existing?.discountAmount ?? null;
        // Reached once per redemption: a settled row returned above, under the lock.
        const logRedemption = async (): Promise<void> => {
          if (price === null || discountAmount === null) return;
          await recordCouponRedeemed(tx, {
            coupon,
            endUserId: args.endUserId,
            subscriptionId,
            paymentId: args.paymentId ?? null,
            discountAmount,
            price: { ...price, currency: currency ?? price.currency },
          });
        };

        if (existing) {
          await tx.couponRedemption.update({
            where: { id: existing.id },
            data: {
              status: 'CONFIRMED',
              // A settled redemption never expires, clearing this is what
              // takes the row out of the "aged out, sweep me" population.
              expiresAt: null,
              ...(args.subscriptionId !== undefined && { subscriptionId: args.subscriptionId }),
              ...(args.paymentId !== undefined && { paymentId: args.paymentId }),
              ...(args.discountAmount !== undefined && { discountAmount: args.discountAmount }),
              ...(existing.currency === null && currency !== null && { currency }),
              ...(existing.planPriceId === null && price?.planPriceId != null && { planPriceId: price.planPriceId }),
            },
          });
          await logRedemption();
          return { recorded: true };
        }

        if (coupon.maxRedemptions !== null) {
          const total = await tx.couponRedemption.count({
            where: { couponId: coupon.id, status: 'CONFIRMED' },
          });
          if (total >= coupon.maxRedemptions) {
            return {
              recorded: false,
              reason: 'limit-reached',
              code: 'COUPON_REDEMPTION_LIMIT_REACHED',
              message: `Coupon "${coupon.code}" has reached its redemption limit.`,
            };
          }
        }
        if (coupon.maxRedemptionsPerUser !== null) {
          const userCount = await tx.couponRedemption.count({
            where: { couponId: coupon.id, endUserId: args.endUserId, status: 'CONFIRMED' },
          });
          if (userCount >= coupon.maxRedemptionsPerUser) {
            return {
              recorded: false,
              reason: 'limit-reached',
              code: 'COUPON_USER_LIMIT_REACHED',
              message: `User has reached the per-user redemption limit for "${coupon.code}".`,
            };
          }
        }

        await tx.couponRedemption.create({
          data: {
            couponId: args.couponId,
            applicationId: args.applicationId,
            endUserId: args.endUserId,
            checkoutSessionId: args.checkoutSessionId,
            subscriptionId,
            paymentId: args.paymentId ?? null,
            discountAmount,
            currency,
            planPriceId: price?.planPriceId ?? null,
            // Settled on arrival, this path exists precisely for the sales
            // that reached us with no reservation to confirm.
            status: 'CONFIRMED',
          },
        });
        await logRedemption();
        return { recorded: true };
      });
    } catch (e) {
      // P2002 = the unique index caught a race the row lock could not (two
      // appliers for the same session on different connections). Same answer
      // as the read above, just discovered a moment later.
      if ((e as { code?: string }).code === 'P2002') {
        return { recorded: false, reason: 'already-redeemed' };
      }
      throw e;
    }
  },
};
