-- Coupon redemptions are recorded once per CHECKOUT SESSION, not once per
-- payment.
--
-- Recording only at payment-success meant a one-time purchase (Stripe
-- `mode: 'payment'`, PayPal Orders v2) never recorded a redemption at all —
-- neither provider emits an invoice for it — so a `maxRedemptions: 1` coupon
-- discounted an unlimited number of one-off checkouts. Recording once per
-- payment meant the opposite failure on a recurring plan: every renewal
-- invoice recorded another redemption for a discount that only ever applied
-- to the first one.
--
-- `checkout_session_id` is the provider's session/order id, which is what
-- identifies "one purchase" on both flows. NULL for rows written before this
-- migration and for any caller with no session in hand; Postgres treats NULLs
-- as distinct in a unique index, so those rows are unaffected.
ALTER TABLE "coupon_redemptions"
  ADD COLUMN "checkout_session_id" TEXT,
  -- What the discount was worth when it was redeemed, in the smallest currency
  -- unit. Previously derived by reading `Subscription.metadata.discountAmount`
  -- back at display time — a value a later checkout on the same
  -- (application, end-user, plan) row overwrites.
  ADD COLUMN "discount_amount" INTEGER;

CREATE UNIQUE INDEX "coupon_redemptions_coupon_id_checkout_session_id_key"
  ON "coupon_redemptions"("coupon_id", "checkout_session_id");
