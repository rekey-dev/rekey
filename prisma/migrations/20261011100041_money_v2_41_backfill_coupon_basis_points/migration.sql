-- Data only. Copies each percentage coupon's rate into `basis_points`.
--
-- Assumes:
--   - `coupons.amount_off` on a PERCENT coupon is basis points, 0 to 10000,
--     which is what the API has accepted since coupons existed. A value
--     outside that range is not copied: the coupon then takes nothing off and
--     is refused where its code is entered.
--   - `coupons.amount_off` is left as it is.
--
-- Guarded by `basis_points IS NULL`, so a second run changes nothing and a
-- rate an operator has since edited is kept. Run it again at the constrain
-- step: a coupon the previous API build creates after this ran has no rate
-- until then.
UPDATE "coupons"
SET "basis_points" = "amount_off"
WHERE "discount_type" = 'PERCENT'
  AND "basis_points" IS NULL
  AND "amount_off" BETWEEN 0 AND 10000;
