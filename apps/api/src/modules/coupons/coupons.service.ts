/**
 * Coupons, discount codes applied at checkout.
 *
 * Two discount kinds (coupon-terms.ts):
 *   - PERCENT, `basisPoints`. `1500` means 15.00%. Works in any currency
 *     unless `currencies` limits it.
 *   - AMOUNT, one `CouponAmount` row per currency, in that currency's
 *     smallest unit. Works only in those currencies.
 *
 * Validity rules (all must hold):
 *   - `active === true`
 *   - now is within [startsAt, endsAt] if either is set
 *   - if `planSlugs` is set, the target plan slug is in it
 *   - the coupon covers the currency of the price being charged, which after
 *     a price fallback is the default price's
 *   - `maxRedemptions` not yet reached across the application
 *   - this end-user hasn't redeemed past `maxRedemptionsPerUser`
 *
 * `code` is case-insensitive, stored and matched lowercase.
 *
 * ## Redemption is two-phase
 *
 * A `CouponRedemption` row exists from the moment the discount is MINTED
 * (`reserveForCheckout`, status RESERVED) and is settled when the provider says
 * the money landed (`redeemForCheckout`, status CONFIRMED). Both states hold a
 * slot against `maxRedemptions` / `maxRedemptionsPerUser`.
 *
 * Single-phase recording does not work in either direction:
 *   - Recording at apply time lets abandoned checkouts burn through the limits
 *     without ever paying.
 *   - Recording only at payment-success checks the ceiling against a webhook
 *     that has not fired yet, while the provider-side discount is payable for
 *     the whole ~24h checkout-session life. Five checkouts on a
 *     `maxRedemptions: 1` coupon can charge five discounts and leave one
 *     redemption row (a window, not a race).
 *
 * A reservation closes both: it exists when the discount exists, and it
 * EXPIRES (`RESERVATION_TTL_MS`), so an abandoned checkout releases its slot on
 * its own. A buyer holds at most `maxRedemptionsPerUser ?? 1` live
 * reservations on one coupon, so one account cannot sit on the whole global
 * ceiling.
 *
 * `redeemForCheckout` also has to work with NO reservation in hand. That is not
 * a legacy path: it is how flows that never went through our checkout settle,
 * and how a purchase whose reservation aged out still gets recorded.
 * Payment-success alone is wrong here too:
 *   - For a one-time purchase, neither Stripe's `mode: 'payment'` session nor a
 *     PayPal Orders v2 capture produces the invoice event the payment applier
 *     hangs off, so nothing would ever get recorded.
 *   - For a recurring one, the provider coupon is `duration: 'once'` (invoice
 *     #1 only) but every renewal invoice would record another redemption, and
 *     hitting a per-user limit inside the payment transaction would roll the
 *     renewal payment back entirely.
 *
 * The grain is therefore (coupon, checkout session), enforced by a unique
 * index. A redemption that cannot be recorded is reported, never thrown at a
 * caller that is in the middle of writing money.
 */

import type { CouponDiscountType, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { recordCouponChanged, recordCouponCreated, recordCouponRefused, type CouponActor } from './coupon-events.js';
import { assertCapsCoverRedeemed, assertCeilingAllowsOneMore, assertLimitsAllowOneMore } from './coupon-limits.js';
import { couponRedemptions } from './coupon-redemptions.js';
import { couponDiscountTotals, type CouponDiscountTotals } from './coupon-stats.js';
import {
  computeDiscount,
  couponTermsAfter,
  couponTermsFor,
  previousBuildColumns,
  type CouponRecord,
  type CouponTerms,
  type CouponTermsInput,
} from './coupon-terms.js';

export { RESERVATION_TTL_MS, type RedemptionOutcome } from './coupon-redemptions.js';
export type { CouponRecord } from './coupon-terms.js';

const CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;

const WITH_AMOUNTS = { amounts: true } as const;

export interface CreateCouponInput extends CouponTermsInput {
  applicationId: string;
  code: string;
  discountType: CouponDiscountType;
  planSlugs?: string[];
  startsAt?: Date;
  endsAt?: Date;
  maxRedemptions?: number;
  maxRedemptionsPerUser?: number;
  metadata?: Record<string, unknown>;
  actor?: CouponActor;
}

export interface UpdateCouponInput extends CouponTermsInput {
  applicationId: string;
  code: string;
  active?: boolean | undefined;
  planSlugs?: string[] | undefined;
  /** Null removes the end date. */
  endsAt?: Date | null | undefined;
  /** Null removes the cap. Refused below what is already redeemed. */
  maxRedemptions?: number | null | undefined;
  maxRedemptionsPerUser?: number | null | undefined;
  actor?: CouponActor;
}

export interface ValidateInput {
  applicationId: string;
  endUserId: string;
  code: string;
  planSlug: string;
  /** The price being charged, in the smallest unit of `currency`. */
  amount: number;
  /** The currency being charged: after a price fallback, the default price's. */
  currency: string;
  /** The currency of the price selected first, when it could not be charged and `currency` is the default price's. */
  fallbackFrom?: string | undefined;
}

/** `validate`'s input with the buyer left optional. */
export type QuoteInput = Omit<ValidateInput, 'endUserId'> & { endUserId?: string | undefined };

export interface ValidateResult {
  coupon: CouponRecord;
  /** Discount in the smallest unit of the currency charged. An integer above 0, never more than the amount. */
  discountAmount: number;
  /** What is left to pay, in the same unit. */
  amountAfterDiscount: number;
}

function normaliseCode(code: string): string {
  return code.trim().toLowerCase();
}

/** A coupon with what it has given away, per currency. See coupon-stats.ts. */
export type CouponWithStats = CouponRecord & CouponDiscountTotals;

/** The filter `list`, `listWithStats` and `count` share. */
function couponListWhere(applicationId: string, includeInactive: boolean) {
  return { applicationId, ...(includeInactive ? {} : { active: true }) };
}

function notFound(code: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'COUPON_NOT_FOUND',
    message: `Coupon "${code}" not found.`,
    fix: 'List this Application\'s coupons with GET /api/v1/tenant/applications/:id/coupons and use a `code` from it.',
  });
}

/**
 * The refusal for a coupon that does not work in the currency being charged.
 * It names the buyer's own currencies and never the ones the coupon covers.
 */
function currencyNotCovered(coupon: CouponRecord, displayCode: string, charged: string, fallbackFrom: string | undefined): RekeyError {
  const refusal = `coupon "${displayCode}" does not work for prices in ${charged}`;
  const remedy =
    coupon.discountType === 'AMOUNT'
      ? `adding an amount in ${charged} to its \`amounts\``
      : `adding ${charged} to its \`currencies\``;
  return new RekeyError({
    statusCode: 400,
    code: 'COUPON_CURRENCY_NOT_COVERED',
    message:
      fallbackFrom === undefined
        ? `${refusal[0]!.toUpperCase()}${refusal.slice(1)}.`
        : `Prices in ${fallbackFrom} cannot be charged yet, so this purchase is charged in ${charged}, and ${refusal}.`,
    fix: `Check out without \`couponCode\` to pay the full price in ${charged}, or use a code that works in ${charged}. Nothing was discounted or converted. The operator can make this code work in ${charged} by ${remedy} (Panel → Application → Coupons, or PATCH /api/v1/tenant/applications/:id/coupons/:code).`,
    details: { chargedCurrency: charged, requestedCurrency: fallbackFrom ?? null },
  });
}

/** Row values for a coupon's discount fields, with the two columns the previous build reads. */
function termsData(discountType: CouponDiscountType, terms: CouponTerms) {
  return { basisPoints: terms.basisPoints, currencies: terms.currencies, ...previousBuildColumns(discountType, terms) };
}

async function replaceAmounts(tx: Prisma.TransactionClient, coupon: { id: string; applicationId: string }, terms: CouponTerms) {
  await tx.couponAmount.deleteMany({ where: { couponId: coupon.id } });
  if (terms.amounts.length === 0) return;
  await tx.couponAmount.createMany({
    data: terms.amounts.map((amount) => ({ ...amount, couponId: coupon.id, applicationId: coupon.applicationId })),
  });
}

export const couponsService = {
  ...couponRedemptions,

  async list(
    applicationId: string,
    includeInactive = false,
    opts?: { take?: number; skip?: number },
  ): Promise<CouponRecord[]> {
    return prisma.coupon.findMany({
      where: couponListWhere(applicationId, includeInactive),
      orderBy: { createdAt: 'desc' },
      include: WITH_AMOUNTS,
      ...(opts?.take !== undefined ? { take: opts.take } : {}),
      ...(opts?.skip !== undefined ? { skip: opts.skip } : {}),
    });
  },

  /** Total coupons matching `list`/`listWithStats`, ignoring take/skip. */
  async count(applicationId: string, includeInactive = false): Promise<number> {
    return prisma.coupon.count({ where: couponListWhere(applicationId, includeInactive) });
  },

  /**
   * Same as `list`, with each coupon's redemption totals for the operator
   * panel. The totals are one grouped query for the whole page.
   *
   * @example
   * const [coupon] = await couponsService.listWithStats(applicationId);
   * coupon?.discountIssuedByCurrency; // [{ currency: 'USD', amount: 1500, redemptions: 3 }]
   */
  async listWithStats(
    applicationId: string,
    includeInactive = false,
    opts?: { take?: number; skip?: number },
  ): Promise<CouponWithStats[]> {
    const coupons = await this.list(applicationId, includeInactive, opts);
    const totals = await couponDiscountTotals(applicationId, coupons);
    return coupons.map((c) => ({ ...c, ...totals.get(c.id)! }));
  },

  /**
   * One coupon by its code, in any letter case.
   *
   * @example
   * const coupon = await couponsService.get(applicationId, 'LAUNCH50');
   */
  async get(applicationId: string, code: string): Promise<CouponRecord> {
    const coupon = await prisma.coupon.findUnique({
      where: { applicationId_code: { applicationId, code: normaliseCode(code) } },
      include: WITH_AMOUNTS,
    });
    if (!coupon) throw notFound(code);
    return coupon;
  },

  /**
   * Create a coupon. The billing log's `coupon.created` is written in the
   * same transaction.
   *
   * @example
   * await couponsService.create({
   *   applicationId, code: 'FIVEOFF', discountType: 'AMOUNT',
   *   amounts: [{ currency: 'USD', amountOff: 500 }, { currency: 'INR', amountOff: 40000 }],
   * });
   */
  async create(input: CreateCouponInput): Promise<CouponRecord> {
    if (!CODE_RE.test(input.code)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_CODE_INVALID',
        message: `Coupon code "${input.code}" must be 1-40 alphanumerics, underscores, or hyphens.`,
        fix: 'Use a code like "LAUNCH50" or "summer-2026".',
      });
    }
    const terms = couponTermsFor(input.discountType, input);
    // Normalise plan slugs to the same lowercase form Plan.slug uses, so
    // `planSlugs.includes(...)` works regardless of operator case.
    const normalisedSlugs = (input.planSlugs ?? []).map((s) => s.toLowerCase());
    try {
      return await prisma.$transaction(async (tx) => {
        const row = await tx.coupon.create({
          data: {
            applicationId: input.applicationId,
            code: normaliseCode(input.code),
            discountType: input.discountType,
            ...termsData(input.discountType, terms),
            planSlugs: normalisedSlugs,
            startsAt: input.startsAt ?? null,
            endsAt: input.endsAt ?? null,
            maxRedemptions: input.maxRedemptions ?? null,
            maxRedemptionsPerUser: input.maxRedemptionsPerUser ?? null,
            metadata: (input.metadata ?? {}) as never,
          },
        });
        await replaceAmounts(tx, row, terms);
        const coupon = await tx.coupon.findUniqueOrThrow({ where: { id: row.id }, include: WITH_AMOUNTS });
        await recordCouponCreated(tx, coupon, input.actor);
        return coupon;
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new RekeyError({
          statusCode: 409,
          code: 'COUPON_CODE_TAKEN',
          message: `Coupon code "${input.code}" already exists in this application.`,
          fix: 'Pick a different code, or change the existing coupon with PATCH /api/v1/tenant/applications/:id/coupons/:code.',
        });
      }
      throw e;
    }
  },

  /**
   * Change a coupon: switch it on or off, replace what it takes off, change
   * where it applies, when it ends or how often it may be redeemed. `amounts`
   * replaces the whole set. The billing log's `coupon.changed` is written in
   * the same transaction, with the terms before and after, unless nothing
   * changed.
   *
   * A checkout already open keeps the discount it was opened with. A cap
   * below the redemptions already held is refused with
   * `COUPON_LIMIT_BELOW_REDEEMED`.
   *
   * @example
   * await couponsService.update({ applicationId, code: 'FIVEOFF', amounts: [{ currency: 'USD', amountOff: 700 }] });
   */
  async update(input: UpdateCouponInput): Promise<CouponRecord> {
    const code = normaliseCode(input.code);
    return prisma.$transaction(async (tx) => {
      // Locked, so two edits cannot interleave their amount rows, the before
      // the log records is the before this edit replaced, and no redemption
      // takes a slot between the cap check and the write.
      await tx.$queryRaw`SELECT id FROM coupons WHERE application_id = ${input.applicationId} AND code = ${code} FOR UPDATE`;
      const before = await tx.coupon.findUnique({
        where: { applicationId_code: { applicationId: input.applicationId, code } },
        include: WITH_AMOUNTS,
      });
      if (!before) throw notFound(input.code);
      const terms = couponTermsAfter(before, input);
      await assertCapsCoverRedeemed(tx, before.id, input);
      await tx.coupon.update({
        where: { id: before.id },
        data: {
          ...(terms !== null && termsData(before.discountType, terms)),
          ...(input.active !== undefined && { active: input.active }),
          ...(input.planSlugs !== undefined && { planSlugs: input.planSlugs.map((s) => s.toLowerCase()) }),
          ...(input.endsAt !== undefined && { endsAt: input.endsAt }),
          ...(input.maxRedemptions !== undefined && { maxRedemptions: input.maxRedemptions }),
          ...(input.maxRedemptionsPerUser !== undefined && { maxRedemptionsPerUser: input.maxRedemptionsPerUser }),
        },
      });
      if (terms !== null && input.amounts !== undefined) await replaceAmounts(tx, before, terms);
      const after = await tx.coupon.findUniqueOrThrow({ where: { id: before.id }, include: WITH_AMOUNTS });
      await recordCouponChanged(tx, before, after, input.actor);
      return after;
    });
  },

  /** Switch a coupon on or off. See `update`. */
  async setActive(applicationId: string, code: string, active: boolean, actor?: CouponActor): Promise<CouponRecord> {
    return this.update({ applicationId, code, active, actor });
  },

  /**
   * Resolve a code and decide what it takes off this price for this buyer.
   * Throws a `RekeyError` with a stable code for every reason it cannot be
   * used, and records the refusal of a known coupon in the billing log.
   *
   * Both the place a code is entered (`POST /billing/coupons/validate`) and
   * the checkout call this with the price the checkout charges, so the two
   * give the same answer.
   *
   * @example
   * const { discountAmount } = await couponsService.validate({
   *   applicationId, endUserId, code: 'LAUNCH', planSlug: 'pro', amount: 1999, currency: 'USD',
   * }); // 300 for a 15% coupon
   */
  async validate(input: ValidateInput): Promise<ValidateResult> {
    const coupon = await couponByCode(input.applicationId, input.code);
    const charged = input.currency.toUpperCase();
    try {
      return await decideDiscount(coupon, input, charged);
    } catch (e) {
      if (e instanceof RekeyError) {
        await recordCouponRefused({
          coupon,
          endUserId: input.endUserId,
          planSlug: input.planSlug,
          reasonCode: e.code,
          chargedCurrency: /^[A-Z]{3}$/.test(charged) ? charged : null,
        });
      }
      throw e;
    }
  },

  /**
   * What `validate` would answer, for an operator asking ahead of any buyer:
   * the same decision, and nothing written to the billing log. With no end
   * user named, the per-buyer limits are not judged, only the coupon's
   * ceiling.
   *
   * @example
   * const { discountAmount } = await couponsService.quote({
   *   applicationId, code: 'LAUNCH', planSlug: 'pro', amount: 149900, currency: 'INR',
   * });
   */
  async quote(input: QuoteInput): Promise<ValidateResult> {
    const coupon = await couponByCode(input.applicationId, input.code);
    return decideDiscount(coupon, input, input.currency.toUpperCase());
  },
};

async function couponByCode(applicationId: string, code: string): Promise<CouponRecord> {
  const coupon = await prisma.coupon.findUnique({
    where: { applicationId_code: { applicationId, code: normaliseCode(code) } },
    include: WITH_AMOUNTS,
  });
  if (!coupon) {
    throw new RekeyError({
      statusCode: 404,
      code: 'COUPON_NOT_FOUND',
      message: `No coupon matching "${code}".`,
      fix: 'Check the code for a typing mistake, or check out without `couponCode` to pay the full price.',
    });
  }
  return coupon;
}

async function decideDiscount(coupon: CouponRecord, input: QuoteInput, charged: string): Promise<ValidateResult> {
  if (!coupon.active) {
    throw new RekeyError({
      statusCode: 400,
      code: 'COUPON_INACTIVE',
      message: `Coupon "${input.code}" is no longer active.`,
      fix: 'Use a different coupon, or have an operator switch this one back on.',
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
      fix: 'Use a different coupon, or check out without `couponCode` to pay the full price.',
    });
  }
  if (coupon.planSlugs.length > 0 && !coupon.planSlugs.includes(input.planSlug)) {
    throw new RekeyError({
      statusCode: 400,
      code: 'COUPON_NOT_APPLICABLE',
      message: `Coupon "${input.code}" does not apply to plan "${input.planSlug}".`,
      // Not the list of plans it does apply to: this answers a buyer.
      fix: 'Use this code on a plan it applies to, or check out without `couponCode` to pay the full price.',
    });
  }
  const discount = computeDiscount(coupon, input.amount, charged);
  if (discount === null) throw currencyNotCovered(coupon, input.code, charged, input.fallbackFrom?.toUpperCase());
  if (discount <= 0) {
    throw new RekeyError({
      statusCode: 400,
      code: 'COUPON_NO_DISCOUNT',
      message: `Coupon "${input.code}" works out to no discount on plan "${input.planSlug}".`,
      fix:
        input.amount <= 0
          ? 'This plan has no price to take a discount off. Check out without `couponCode`.'
          : 'Check out without `couponCode` to pay the full price. This coupon has a percentage of 0: the operator can set one by sending `basisPoints` from 1 to 10000 to PATCH /api/v1/tenant/applications/:id/coupons/:code.',
    });
  }
  // Limits, counted the same way `reserveForCheckout` counts them, a
  // pricing page that quotes a discount checkout is about to refuse is worse
  // than no quote at all. See assertLimitsAllowOneMore.
  if (input.endUserId === undefined) await assertCeilingAllowsOneMore(prisma, coupon, input.code);
  else await assertLimitsAllowOneMore(prisma, coupon, input.endUserId, input.code);
  return { coupon, discountAmount: discount, amountAfterDiscount: input.amount - discount };
}
