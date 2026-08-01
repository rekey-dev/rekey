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
 * Redemption is recorded in `CouponRedemption` when the provider tells us the
 * purchase went through — `webhooks/apply.ts` calls `redeemForCheckout` from
 * checkout completion (one-time flows, where fulfilment happens) and from
 * payment success (recurring flows). Until then the coupon just rides along on
 * `Subscription.metadata.couponBySession`.
 *
 * It used to be recorded at apply time, on the theory that slight overcounting
 * was harmless. It wasn't: abandoning checkouts in a loop let an attacker burn
 * through `maxRedemptions` / `maxRedemptionsPerUser` without ever paying, which
 * is a denial-of-discount against every other customer. Don't move it back
 * earlier — a redemption should cost money.
 *
 * It was then recorded ONLY at payment-success, which was wrong in both
 * directions and is why `redeemForCheckout` exists:
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

import type { Coupon } from '@prisma/client';
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
      select: { couponId: true, discountAmount: true },
    });
    const couponById = new Map(coupons.map((c) => [c.id, c]));

    const countBy = new Map<string, number>();
    const discountBy = new Map<string, number>();
    for (const r of redemptions) {
      countBy.set(r.couponId, (countBy.get(r.couponId) ?? 0) + 1);
      const coupon = couponById.get(r.couponId);
      if (!coupon) continue;
      const discount =
        r.discountAmount !== null && Number.isFinite(r.discountAmount)
          ? r.discountAmount
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
   * Record the redemption of a coupon against ONE completed checkout session,
   * with the limit re-check. The earlier `validate` call is an *advisory* gate
   * (TOCTOU-vulnerable); this is the authoritative one. It runs in a
   * transaction with a row-level lock on the coupon row so two concurrent
   * webhook handlers cannot both pass the count check.
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

        // Checked BEFORE the limits, and inside the lock: an already-recorded
        // session is a no-op even when the coupon is now exhausted, so a
        // replayed webhook cannot be reported as a limit failure.
        const existing = await tx.couponRedemption.findFirst({
          where: { couponId: coupon.id, checkoutSessionId: args.checkoutSessionId },
          select: { id: true },
        });
        if (existing) return { recorded: false, reason: 'already-redeemed' };

        if (coupon.maxRedemptions !== null) {
          const total = await tx.couponRedemption.count({ where: { couponId: coupon.id } });
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
            where: { couponId: coupon.id, endUserId: args.endUserId },
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
