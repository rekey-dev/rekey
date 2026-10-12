-- Data only. Gives each fixed-amount coupon one amount row, in the currency
-- it was created in, written in upper case.
--
-- Assumes:
--   - A fixed-amount coupon discounts only in its own `currency`.
--   - One with no currency discounts nothing: the API has refused it at
--     checkout since a currency became required. It gets no amount row, and
--     neither does one whose currency is not three letters (query 10 of the
--     preflight lists those).
--   - `coupons.amount_off` and `coupons.currency` are left as they are.
--
-- Guarded by the unique (coupon_id, currency), so a second run changes
-- nothing and an amount an operator has since edited is kept.
INSERT INTO "coupon_amounts" ("id", "application_id", "coupon_id", "currency", "amount_off", "created_at")
SELECT
  'ca_' || md5(c."id" || ':' || upper(c."currency")),
  c."application_id",
  c."id",
  upper(c."currency"),
  c."amount_off",
  c."created_at"
FROM "coupons" AS c
WHERE c."discount_type" = 'AMOUNT'
  AND upper(c."currency") ~ '^[A-Z]{3}$'
  AND c."amount_off" > 0
ON CONFLICT ("coupon_id", "currency") DO NOTHING;
