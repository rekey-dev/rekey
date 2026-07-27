/**
 * Coupons — discount codes applied at checkout.
 *
 * Two discount kinds:
 *   - PERCENT — `amountOff` is basis points × 10. `1500` means 15.00%.
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
 * Redemption is recorded in `CouponRedemption` when the coupon is *applied*
 * to a checkout session. We optimistically count it as consumed at apply
 * time; if the user abandons checkout, the redemption row exists but isn't
 * linked to a successful Payment. Cleanup of "stale apply but no pay" rows
 * is a future concern — for now slightly-overcounting is acceptable.
 */

import type { Coupon, Prisma } from '@prisma/client';
import { CouponDiscountType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';

const CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;

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
  /** How many times this coupon has been redeemed (rows in coupon_redemptions). */
  redemptionCount: number;
  /**
   * Total discount granted across redemptions, in the smallest currency unit.
   * Best-effort: per-redemption discount isn't stored on the redemption row —
   * checkout records it on the subscription's metadata (`discountAmount`).
   * We sum that where available and fall back to `amountOff` for AMOUNT
   * coupons (exact unless clamped); PERCENT redemptions without a linked
   * subscription contribute 0.
   */
  totalDiscountIssued: number;
}

function computeDiscount(coupon: Coupon, amount: number): number {
  if (coupon.discountType === 'PERCENT') {
    // amountOff = basis-points × 10, so 1500 → 15.00%. Floor to int cents.
    const raw = Math.floor((amount * coupon.amountOff) / 10000);
    return Math.min(raw, amount);
  }
  return Math.min(coupon.amountOff, amount);
}

export const couponsService = {
  async list(
    applicationId: string,
    includeInactive = false,
    opts?: { take?: number; skip?: number },
  ): Promise<Coupon[]> {
    return prisma.coupon.findMany({
      where: { applicationId, ...(includeInactive ? {} : { active: true }) },
      orderBy: { createdAt: 'desc' },
      ...(opts?.take !== undefined ? { take: opts.take } : {}),
      ...(opts?.skip !== undefined ? { skip: opts.skip } : {}),
    });
  },

  /**
   * Same as `list`, but with redemption stats for the operator panel:
   * `redemptionCount` and `totalDiscountIssued` (see CouponWithStats for the
   * derivation caveats). Two extra bounded queries — redemption rows for the
   * page's coupons, then the linked subscriptions' metadata.
   */
  async listWithStats(
    applicationId: string,
    includeInactive = false,
    opts?: { take?: number; skip?: number },
  ): Promise<CouponWithStats[]> {
    const coupons = await this.list(applicationId, includeInactive, opts);
    if (coupons.length === 0) return [];

    const redemptions = await prisma.couponRedemption.findMany({
      where: { couponId: { in: coupons.map((c) => c.id) } },
      select: { couponId: true, subscriptionId: true },
    });
    const subIds = [
      ...new Set(redemptions.map((r) => r.subscriptionId).filter((v): v is string => v !== null)),
    ];
    const subs = subIds.length
      ? await prisma.subscription.findMany({
          where: { id: { in: subIds } },
          select: { id: true, metadata: true },
        })
      : [];
    const metaById = new Map(subs.map((s) => [s.id, s.metadata]));
    const couponById = new Map(coupons.map((c) => [c.id, c]));

    const countBy = new Map<string, number>();
    const discountBy = new Map<string, number>();
    for (const r of redemptions) {
      countBy.set(r.couponId, (countBy.get(r.couponId) ?? 0) + 1);
      const coupon = couponById.get(r.couponId);
      if (!coupon) continue;
      const meta = r.subscriptionId
        ? (metaById.get(r.subscriptionId) as Record<string, unknown> | null | undefined)
        : null;
      const recorded = meta && typeof meta === 'object' ? meta['discountAmount'] : undefined;
      const discount =
        typeof recorded === 'number' && Number.isFinite(recorded)
          ? recorded
          : coupon.discountType === 'AMOUNT'
            ? coupon.amountOff
            : 0;
      discountBy.set(r.couponId, (discountBy.get(r.couponId) ?? 0) + discount);
    }

    return coupons.map((c) => ({
      ...c,
      redemptionCount: countBy.get(c.id) ?? 0,
      totalDiscountIssued: discountBy.get(c.id) ?? 0,
    }));
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
        fix: 'PERCENT discounts use basis-points × 10 (1500 = 15%); AMOUNT discounts use cents.',
      });
    }
    if (input.discountType === 'PERCENT' && input.amountOff > 10000) {
      throw new RekeyError({
        statusCode: 400,
        code: 'COUPON_AMOUNT_INVALID',
        message: `PERCENT coupon amountOff "${input.amountOff}" exceeds 100% (10000).`,
        fix: 'PERCENT discount is capped at 10000 basis-points-times-10 (= 100%). For full-comp, use AMOUNT >= price.',
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
    if (coupon.maxRedemptions !== null) {
      const total = await prisma.couponRedemption.count({ where: { couponId: coupon.id } });
      if (total >= coupon.maxRedemptions) {
        throw new RekeyError({
          statusCode: 400,
          code: 'COUPON_REDEMPTION_LIMIT_REACHED',
          message: `Coupon "${input.code}" has reached its redemption limit.`,
          fix: 'Use a different coupon — this one is fully consumed.',
        });
      }
    }
    if (coupon.maxRedemptionsPerUser !== null) {
      const userCount = await prisma.couponRedemption.count({
        where: { couponId: coupon.id, endUserId: input.endUserId },
      });
      if (userCount >= coupon.maxRedemptionsPerUser) {
        throw new RekeyError({
          statusCode: 400,
          code: 'COUPON_USER_LIMIT_REACHED',
          message: `You have already used coupon "${input.code}" the maximum number of times.`,
          fix: 'Use a different coupon for this purchase.',
        });
      }
    }

    const discount = computeDiscount(coupon, input.amount);
    return {
      coupon,
      discountAmount: discount,
      amountAfterDiscount: input.amount - discount,
    };
  },

  /**
   * Record a redemption atomically with the limit re-check. The earlier
   * `validate` call is an *advisory* gate (TOCTOU-vulnerable); this is
   * the authoritative one. Wrapped in a serialisable transaction with a
   * row-level lock on the coupon row so two concurrent webhook handlers
   * cannot both pass the count check.
   *
   * Throws `RekeyError`(COUPON_REDEMPTION_LIMIT_REACHED / COUPON_USER_LIMIT_REACHED)
   * when the limit is now exceeded. Callers that just want the idempotent
   * "already recorded" behaviour should catch P2002 via the
   * `(couponId, paymentId)` unique index — re-recording the same payment
   * is a no-op (used by webhook replay).
   *
   * Pass `outerTx` to run inside an existing transaction (the billing
   * webhook handlers create the Payment row and the redemption atomically
   * — neither must commit without the other). The coupon row lock is taken
   * either way.
   */
  async recordRedemption(
    args: {
      couponId: string;
      applicationId: string;
      endUserId: string;
      subscriptionId?: string;
      paymentId?: string;
    },
    outerTx?: Prisma.TransactionClient,
  ): Promise<void> {
    const run = async (tx: Prisma.TransactionClient): Promise<void> => {
      // Pessimistic lock on the coupon row — serialises every concurrent
      // redemption attempt against the same coupon, so the count we read
      // below is authoritative for the duration of this transaction.
      await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${args.couponId} FOR UPDATE`;

      const coupon = await tx.coupon.findUniqueOrThrow({
        where: { id: args.couponId },
      });

      if (coupon.maxRedemptions !== null) {
        const total = await tx.couponRedemption.count({ where: { couponId: coupon.id } });
        if (total >= coupon.maxRedemptions) {
          throw new RekeyError({
            statusCode: 400,
            code: 'COUPON_REDEMPTION_LIMIT_REACHED',
            message: `Coupon "${coupon.code}" has reached its redemption limit.`,
            fix: 'No further redemptions can be recorded against this coupon.',
          });
        }
      }
      if (coupon.maxRedemptionsPerUser !== null) {
        const userCount = await tx.couponRedemption.count({
          where: { couponId: coupon.id, endUserId: args.endUserId },
        });
        if (userCount >= coupon.maxRedemptionsPerUser) {
          throw new RekeyError({
            statusCode: 400,
            code: 'COUPON_USER_LIMIT_REACHED',
            message: `User has reached the per-user redemption limit for "${coupon.code}".`,
            fix: 'No further redemptions can be recorded for this user.',
          });
        }
      }

      await tx.couponRedemption.create({
        data: {
          couponId: args.couponId,
          applicationId: args.applicationId,
          endUserId: args.endUserId,
          subscriptionId: args.subscriptionId ?? null,
          paymentId: args.paymentId ?? null,
        },
      });
    };
    if (outerTx) {
      await run(outerTx);
      return;
    }
    await prisma.$transaction(run);
  },
};
