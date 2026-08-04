-- Coupon redemptions become two-phase: RESERVED at checkout-create, CONFIRMED
-- when the payment settles.
--
-- Why: `maxRedemptions` was checked against `coupon_redemptions`, whose only
-- writer ran AFTER the provider settled the payment. The discount, however, is
-- minted at the provider when the checkout session is created and stays payable
-- for the session's whole ~24h life — so the ceiling was enforced against rows
-- that did not exist yet. Five checkouts on a `maxRedemptions: 1` coupon
-- charged five discounts and left one row behind.
--
-- Every row that exists today was written by a payment applier, after
-- settlement, so CONFIRMED is the correct backfill and the DEFAULT keeps any
-- writer that predates this migration correct.

CREATE TYPE "CouponRedemptionStatus" AS ENUM ('RESERVED', 'CONFIRMED');

ALTER TABLE "coupon_redemptions"
  ADD COLUMN "status" "CouponRedemptionStatus" NOT NULL DEFAULT 'CONFIRMED',
  ADD COLUMN "expires_at" TIMESTAMP(3);
