/**
 * Coupons — discount codes applied at checkout.
 *
 * Two discount kinds:
 *   - PERCENT — `amountOff` is basis points. `1500` means 15.00%.
 *   - AMOUNT  — `amountOff` is in the smallest currency unit. `500` is $5.00.
 *
 * Validity rules (all must hold):
 *   - `active === true`
 *   - now is within [startsAt, endsAt] if either is set
 *   - `maxRedemptions` not yet reached across the application
 *   - this end-user hasn't redeemed past `maxRedemptionsPerUser`
 *   - if `planSlugs` is set, the target plan slug is in it
 *   - if `currency` is set on an AMOUNT coupon, plan currency must match
 *
 * `code` is case-insensitive — we lowercase on storage and on validation.
 *
 * ## Redemption is two-phase, and has to be
 *
 * A `CouponRedemption` row exists from the moment the discount is MINTED
 * (`reserveForCheckout`, status RESERVED) and is settled when the provider says
 * the money landed (`redeemForCheckout`, status CONFIRMED). Both states hold a
 * slot against `maxRedemptions` / `maxRedemptionsPerUser`.
 *
 * The history is worth keeping, because both single-phase spellings were wrong
 * and the second one cost real money:
 *
 *   - **Recorded at apply time.** Abandoning checkouts in a loop burned through
 *     the limits without ever paying — a denial-of-discount against every other
 *     customer.
 *   - **Recorded only at payment-success.** The ceiling was then checked
 *     against rows written by a webhook that had not fired yet, while the
 *     provider-side discount went live the instant the checkout session was
 *     created and stayed payable for that session's whole ~24h life. Five
 *     checkouts on a `maxRedemptions: 1` coupon charged five discounts and left
 *     one redemption row. Not a race — the window is the session lifetime.
 *
 * A reservation is the only shape that closes both: it exists when the discount
 * exists, and it EXPIRES, so an abandoned checkout releases its slot without
 * anyone having to notice (`RESERVATION_TTL_MS`). Its cost is bounded too — a
 * buyer holds at most `maxRedemptionsPerUser ?? 1` live reservations on one
 * coupon, so a single account cannot sit on a whole global ceiling.
 *
 * `redeemForCheckout` also has to work with NO reservation in hand, and that is
 * not a legacy path — it is how the flows that never went through our checkout
 * settle, and how a purchase whose reservation aged out is still recorded. It
 * exists in its own right because payment-success alone was wrong in both
 * directions:
 *
 *   - **Never, for a one-time purchase.** Neither Stripe's `mode: 'payment'`
 *     session nor a PayPal Orders v2 capture produces the invoice event the
 *     payment applier hangs off, so a `maxRedemptions: 1` coupon discounted an
 *     unlimited number of one-off checkouts and recorded nothing.
 *   - **Every period, for a recurring one.** The provider coupon is
 *     `duration: 'once'` and discounts invoice #1 only, but every renewal
 *     invoice recorded another redemption — and once a per-user limit was
 *     reached the redemption threw *inside the payment transaction* and rolled
 *     the renewal payment back entirely.
 *
 * The grain is therefore (coupon, checkout session), enforced by a unique
 * index, and a redemption that cannot be recorded is reported, never thrown at
 * a caller that is in the middle of writing money.
 */

import type { Coupon, Prisma } from '@prisma/client';
import { CouponDiscountType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';

const CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * How long a checkout reservation holds its slot against the coupon's limits.
 *
 * Pinned to the longest a provider checkout session — and the ad-hoc discount
 * minted alongside it — stays payable. Stripe Checkout Sessions expire after
 * 24 hours, and PayPal orders and Razorpay payment links are in the same range.
 * A shorter TTL would let the slot come back while the discount was still
 * chargeable, which is precisely the hole reservations exist to close.
 *
 * It is deliberately not longer, either: a reservation nobody releases is a
 * denial-of-discount primitive, the exact mirror of the over-issue bug.
 */
export const RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Rows that currently hold a slot against a coupon's GLOBAL ceiling: every
 * settled redemption, plus reservations that have not aged out.
 *
 * `excludeReservationsFor` drops one buyer's own live reservations. Every
 * caller that is about to reserve, or is pricing a checkout for that buyer,
 * passes it: their existing reservation is a slot they already hold, and
 * counting it against them would make their own open checkout look like
 * somebody else's.
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
type Db = Pick<typeof prisma, 'couponRedemption'> | Prisma.TransactionClient;

/**
 * Refuse unless this buyer may take ONE more slot on this coupon. Shared by the
 * advisory `validate` and the authoritative `reserveForCheckout` so the two can
 * never disagree about who is allowed to check out.
 *
 * Three rules, and the middle one is the reason a reservation cannot be abused
 * as a denial primitive:
 *
 *   1. The GLOBAL ceiling counts settled redemptions plus everyone ELSE's live
 *      reservations. This buyer's own reservation is a slot they already hold;
 *      counting it here would refuse them their own open checkout.
 *   2. A buyer holds at most `maxRedemptionsPerUser ?? 1` live reservations, so
 *      one account cannot mint an unbounded number of payable discounts, nor
 *      sit on a whole global ceiling by opening checkouts in a loop.
 *   3. Settled + reserved must stay within `maxRedemptionsPerUser`, so a
 *      reservation is never minted that could not legally settle.
 */
async function assertLimitsAllowOneMore(
  db: Db,
  coupon: Coupon,
  endUserId: string,
  displayCode: string,
): Promise<void> {
  const now = new Date();

  if (coupon.maxRedemptions !== null) {
    const held = await db.couponRedemption.count({
      where: slotHolderWhere(coupon.id, now, endUserId),
    });
    if (held >= coupon.maxRedemptions) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_REDEMPTION_LIMIT_REACHED',
        message: `Coupon "${displayCode}" has reached its redemption limit.`,
        fix: 'Use a different coupon — this one is fully consumed.',
      });
    }
  }

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
  // Only bites when the coupon has no per-user limit at all — rule 3 covers
  // the rest.
  if (reservedByUser >= (coupon.maxRedemptionsPerUser ?? 1)) {
    throw checkoutAlreadyOpen(displayCode);
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

export interface CreateCouponInput {
  applicationId: string;
  code: string;
  discountType: CouponDiscountType;
  amountOff: number;
  currency?: string;
  planSlugs?: string[];
  startsAt?: Date;
  endsAt?: Date;
  maxRedemptions?: number;
  maxRedemptionsPerUser?: number;
  metadata?: Record<string, unknown>;
}

export interface ValidateInput {
  applicationId: string;
  endUserId: string;
  code: string;
  planSlug: string;
  amount: number;
  currency: string;
}

export interface ValidateResult {
  coupon: Coupon;
  /** Discount in the smallest currency unit (cents). Always integer; >= 0; clamped to amount. */
  discountAmount: number;
  /** Final price after discount, in the smallest currency unit. */
  amountAfterDiscount: number;
}

function normaliseCode(code: string): string {
  return code.trim().toLowerCase();
}

export interface CouponWithStats extends Coupon {
  /**
   * How many times this coupon has been redeemed — CONFIRMED rows only.
   * Reservations are money that has not moved, and an operator reading
   * "redeemed 4 times" off open checkouts would be reading a forecast.
   */
  redemptionCount: number;
  /**
   * Total discount granted across redemptions, in the smallest currency unit.
   *
   * Summed from `CouponRedemption.discountAmount`, which is stamped at
   * redemption time. It used to be read back off the linked subscription's
   * `metadata.discountAmount` — a value the NEXT checkout on the same
   * (application, end-user, plan) row overwrites, so the operator's historical
   * totals were restated by activity that had nothing to do with them.
   * Redemptions written before that column existed still take the old
   * best-effort path: `amountOff` for AMOUNT coupons (exact unless it was
   * clamped to the plan price), 0 for PERCENT.
   */
  totalDiscountIssued: number;
}

/** Why `redeemForCheckout` did or did not write a row. See the method. */
export type RedemptionOutcome =
  /** A new `CouponRedemption` row was written. */
  | { recorded: true }
  /** This (coupon, checkout session) was already redeemed — replay, or the
   *  other applier got there first. Nothing to do, and not an error. */
  | { recorded: false; reason: 'already-redeemed' }
  /** A global / per-user limit is now exhausted. The purchase still stands;
   *  the operator's coupon books simply cannot record this one. */
  | { recorded: false; reason: 'limit-reached'; code: string; message: string };

function computeDiscount(coupon: Coupon, amount: number): number {
  if (coupon.discountType === 'PERCENT') {
    // amountOff = basis points, so 1500 → 15.00%. Floor to int cents.
    const raw = Math.floor((amount * coupon.amountOff) / 10000);
    return Math.min(raw, amount);
  }
  return Math.min(coupon.amountOff, amount);
}

/** The filter `list`, `listWithStats` and `count` share. */
function couponListWhere(applicationId: string, includeInactive: boolean) {
  return { applicationId, ...(includeInactive ? {} : { active: true }) };
}

export const couponsService = {
  async list(
    applicationId: string,
    includeInactive = false,
    opts?: { take?: number; skip?: number },
  ): Promise<Coupon[]> {
    return prisma.coupon.findMany({
      where: couponListWhere(applicationId, includeInactive),
      orderBy: { createdAt: 'desc' },
      ...(opts?.take !== undefined ? { take: opts.take } : {}),
      ...(opts?.skip !== undefined ? { skip: opts.skip } : {}),
    });
  },

  /** Total coupons matching `list`/`listWithStats`, ignoring take/skip. */
  async count(applicationId: string, includeInactive = false): Promise<number> {
    return prisma.coupon.count({ where: couponListWhere(applicationId, includeInactive) });
  },

  /**
   * Same as `list`, but with redemption stats for the operator panel:
   * `redemptionCount` and `totalDiscountIssued` (see CouponWithStats for the
   * derivation caveats).
   *
   * ONE aggregate query, grouped in Postgres. It used to `findMany` the
   * redemption ROWS for the page's coupons and count/sum them into two JS
   * Maps — the comment called that "two extra bounded queries" and it was
   * neither bounded nor two: there is no `take`, so a coupon with a long
   * history pulled its entire redemption table across the wire (40k rows
   * measured) to produce two integers per coupon. A `groupBy` returns one row
   * per coupon regardless.
   *
   * The `_count` / `_sum` split is what the display caveat needs: rows written
   * before `discount_amount` existed have it NULL, and `_sum` skips NULLs, so
   * `count - (rows with a value)` is the number that still needs the
   * best-effort fallback below.
   */
  async listWithStats(
    applicationId: string,
    includeInactive = false,
    opts?: { take?: number; skip?: number },
  ): Promise<CouponWithStats[]> {
    const coupons = await this.list(applicationId, includeInactive, opts);
    if (coupons.length === 0) return [];

    const grouped = await prisma.couponRedemption.groupBy({
      by: ['couponId'],
      // CONFIRMED only — see CouponWithStats.redemptionCount.
      where: { couponId: { in: coupons.map((c) => c.id) }, status: 'CONFIRMED' },
      _count: { _all: true, discountAmount: true },
      _sum: { discountAmount: true },
    });
    const statsBy = new Map(grouped.map((g) => [g.couponId, g]));

    return coupons.map((c) => {
      const g = statsBy.get(c.id);
      if (!g) return { ...c, redemptionCount: 0, totalDiscountIssued: 0 };
      // Legacy rows (discountAmount NULL) fall back to the coupon's own
      // amountOff for AMOUNT, and contribute nothing for PERCENT — exactly
      // what the per-row loop did.
      const legacyRows = g._count._all - g._count.discountAmount;
      const legacyValue = c.discountType === 'AMOUNT' ? legacyRows * c.amountOff : 0;
      return {
        ...c,
        redemptionCount: g._count._all,
        totalDiscountIssued: (g._sum.discountAmount ?? 0) + legacyValue,
      };
    });
  },

  async create(input: CreateCouponInput): Promise<Coupon> {
    if (!CODE_RE.test(input.code)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_CODE_INVALID',
        message: `Coupon code "${input.code}" must be 1-40 alphanumerics, underscores, or hyphens.`,
        fix: 'Use a code like "LAUNCH50" or "summer-2026".',
      });
    }
    if (input.amountOff < 0) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_AMOUNT_INVALID',
        message: 'Coupon amountOff must be >= 0.',
        fix: 'PERCENT discounts use basis points (1500 = 15%); AMOUNT discounts use cents.',
      });
    }
    if (input.discountType === 'PERCENT' && input.amountOff > 10000) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_AMOUNT_INVALID',
        message: `PERCENT coupon amountOff "${input.amountOff}" exceeds 100% (10000).`,
        fix: 'PERCENT discount is capped at 10000 basis points (= 100%). For full-comp, use AMOUNT >= price.',
      });
    }

    // Normalise plan slugs to the same lowercase form Plan.slug uses, so
    // `planSlugs.includes(...)` works regardless of operator case.
    const normalisedSlugs = (input.planSlugs ?? []).map((s) => s.toLowerCase());
    try {
      return await prisma.coupon.create({
        data: {
          applicationId: input.applicationId,
          code: normaliseCode(input.code),
          discountType: input.discountType,
          amountOff: input.amountOff,
          currency: input.currency ?? null,
          planSlugs: normalisedSlugs,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
          maxRedemptions: input.maxRedemptions ?? null,
          maxRedemptionsPerUser: input.maxRedemptionsPerUser ?? null,
          metadata: (input.metadata ?? {}) as never,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new RekeyError({
          statusCode: 409,
          code: 'COUPON_CODE_TAKEN',
          message: `Coupon code "${input.code}" already exists in this application.`,
          fix: 'Pick a different code or update the existing coupon.',
        });
      }
      throw e;
    }
  },

  async setActive(applicationId: string, code: string, active: boolean): Promise<Coupon> {
    const coupon = await prisma.coupon.findUnique({
      where: { applicationId_code: { applicationId, code: normaliseCode(code) } },
    });
    if (!coupon) {
      throw new RekeyError({
        statusCode: 404,
        code: 'COUPON_NOT_FOUND',
        message: `Coupon "${code}" not found.`,
        fix: 'List coupons via GET /api/v1/admin/applications/:id/coupons.',
      });
    }
    return prisma.coupon.update({ where: { id: coupon.id }, data: { active } });
  },

  /**
   * Resolve a code → coupon and validate it for this user, plan, and amount.
   * Throws `RekeyError` with a stable code on every failure mode so the
   * SDK / panel can render a useful message.
   */
  async validate(input: ValidateInput): Promise<ValidateResult> {
    const code = normaliseCode(input.code);
    const coupon = await prisma.coupon.findUnique({
      where: { applicationId_code: { applicationId: input.applicationId, code } },
    });
    if (!coupon) {
      throw new RekeyError({
        statusCode: 404,
        code: 'COUPON_NOT_FOUND',
        message: `No active coupon matching "${input.code}".`,
        fix: 'Verify the code with the operator.',
      });
    }
    if (!coupon.active) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_INACTIVE',
        message: `Coupon "${input.code}" is no longer active.`,
        fix: 'Use a different coupon, or have an admin reactivate this one.',
      });
    }
    const now = new Date();
    if (coupon.startsAt && now < coupon.startsAt) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_NOT_YET_STARTED',
        message: `Coupon "${input.code}" is not active until ${coupon.startsAt.toISOString()}.`,
        fix: 'Try again after the coupon\'s start date.',
      });
    }
    if (coupon.endsAt && now > coupon.endsAt) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_EXPIRED',
        message: `Coupon "${input.code}" expired on ${coupon.endsAt.toISOString()}.`,
        fix: 'This coupon is no longer valid.',
      });
    }
    if (coupon.planSlugs.length > 0 && !coupon.planSlugs.includes(input.planSlug)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_NOT_APPLICABLE',
        message: `Coupon "${input.code}" does not apply to plan "${input.planSlug}".`,
        fix: `This coupon is only valid for: ${coupon.planSlugs.join(', ')}.`,
      });
    }
    if (
      coupon.discountType === 'AMOUNT' &&
      coupon.currency &&
      coupon.currency.toUpperCase() !== input.currency.toUpperCase()
    ) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_CURRENCY_MISMATCH',
        message: `Coupon "${input.code}" is denominated in ${coupon.currency} but the plan is in ${input.currency}.`,
        fix: 'Pick a coupon in the matching currency, or one without a currency restriction.',
      });
    }
    // Limits, counted the same way `reserveForCheckout` counts them — a
    // pricing page that quotes a discount checkout is about to refuse is worse
    // than no quote at all. See assertLimitsAllowOneMore.
    await assertLimitsAllowOneMore(prisma, coupon, input.endUserId, input.code);

    const discount = computeDiscount(coupon, input.amount);
    return {
      coupon,
      discountAmount: discount,
      amountAfterDiscount: input.amount - discount,
    };
  },

  /**
   * Take a RESERVED slot on a coupon for a checkout that is about to be
   * created, and return its id. Throws the same `RekeyError` codes `validate`
   * does when the coupon has no slot left for this buyer.
   *
   * THIS is the authoritative limit check, not `validate`: it runs inside a
   * transaction that holds the coupon row `FOR UPDATE`, so concurrent checkouts
   * on the same coupon serialise here rather than all reading the same count.
   *
   * Called BEFORE the provider round-trip, and therefore before a session id
   * exists — that ordering is the whole point. The provider mints the discount
   * inside `createCheckoutSession`; a slot taken afterwards would be taken
   * after the money was already discountable. `bindReservationToSession` fills
   * the session in once the provider answers, and `releaseReservation` gives
   * the slot straight back when it doesn't.
   */
  async reserveForCheckout(args: {
    couponId: string;
    applicationId: string;
    endUserId: string;
    /** Display form of the code, for the refusal messages. */
    code: string;
    /** Discount in the smallest currency unit, as resolved at checkout time. */
    discountAmount: number;
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
   * happened — the provider call threw, so no discount was ever minted and
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
   * (TOCTOU-vulnerable); the reservation is the binding one. This runs in a
   * transaction with a row-level lock on the coupon row so two concurrent
   * webhook handlers cannot both pass the count check.
   *
   * ## Confirming beats counting
   *
   * When the session has a RESERVED row, this only flips it to CONFIRMED — no
   * limit check at all, deliberately. The slot was taken when the discount was
   * minted; re-testing a ceiling that this very row is counted in would refuse
   * the settlement of a purchase the buyer was entitled to make. That includes
   * a reservation that has aged out: the money moved, and a redemption whose
   * expiry raced the provider's webhook is still a redemption.
   *
   * The no-reservation path (a provider flow that never went through our
   * checkout, a reservation swept between binding and settlement) keeps the
   * historical behaviour — count CONFIRMED rows, and report rather than throw.
   *
   * ## Idempotent, by (coupon, checkout session)
   *
   * Both the checkout applier and the payment applier call this for the same
   * purchase, and the provider replays webhooks freely, so this is called
   * several times per sale by design. Exactly one row results. The grain is
   * the checkout session rather than the subscription because a subscription
   * row is reused: the same (application, end-user, plan) row backs a repeat
   * one-time purchase, which is a second discount and must be a second
   * redemption, while a recurring subscription's renewals reuse the session
   * that bought the single discounted invoice and must not be.
   *
   * ## Never throws for a business reason
   *
   * This is called from webhook appliers that have just written, or are about
   * to write, a `Payment` row. A redemption that cannot be recorded — the
   * coupon has since been exhausted, or a per-user limit was configured that
   * the renewal now exceeds — is a bookkeeping fact, not a reason to fail the
   * delivery. It used to throw from inside the payment transaction, which
   * rolled the payment back: the money moved at the provider, the local
   * `Payment` row never existed, the subscription's status and period were
   * never mirrored, entitlements were never re-provisioned, and the provider
   * retried the poisoned event until it gave up. The outcome is returned so
   * the caller can log it; genuine infrastructure failures still throw.
   *
   * Deliberately NOT given an `outerTx` parameter. Running inside the caller's
   * transaction is exactly what made a redemption failure able to undo a
   * payment, and a Postgres transaction that has hit a constraint violation
   * cannot be continued anyway — so the isolation is load-bearing, not a
   * style choice.
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
  }): Promise<RedemptionOutcome> {
    try {
      return await prisma.$transaction(async (tx): Promise<RedemptionOutcome> => {
        // Pessimistic lock on the coupon row — serialises every concurrent
        // redemption attempt against the same coupon, so the counts read
        // below are authoritative for the duration of this transaction.
        await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${args.couponId} FOR UPDATE`;

        const coupon = await tx.coupon.findUniqueOrThrow({ where: { id: args.couponId } });

        // Checked BEFORE the limits, and inside the lock: an already-settled
        // session is a no-op even when the coupon is now exhausted, so a
        // replayed webhook cannot be reported as a limit failure. A RESERVED
        // row is this sale's own slot — confirm it rather than count it.
        const existing = await tx.couponRedemption.findFirst({
          where: { couponId: coupon.id, checkoutSessionId: args.checkoutSessionId },
          select: { id: true, status: true },
        });
        if (existing?.status === 'CONFIRMED') return { recorded: false, reason: 'already-redeemed' };
        if (existing) {
          await tx.couponRedemption.update({
            where: { id: existing.id },
            data: {
              status: 'CONFIRMED',
              // A settled redemption never expires — clearing this is what
              // takes the row out of the "aged out, sweep me" population.
              expiresAt: null,
              ...(args.subscriptionId !== undefined && { subscriptionId: args.subscriptionId }),
              ...(args.paymentId !== undefined && { paymentId: args.paymentId }),
              ...(args.discountAmount !== undefined && { discountAmount: args.discountAmount }),
            },
          });
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
            subscriptionId: args.subscriptionId ?? null,
            paymentId: args.paymentId ?? null,
            discountAmount: args.discountAmount ?? null,
            // Settled on arrival — this path exists precisely for the sales
            // that reached us with no reservation to confirm.
            status: 'CONFIRMED',
          },
        });
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
