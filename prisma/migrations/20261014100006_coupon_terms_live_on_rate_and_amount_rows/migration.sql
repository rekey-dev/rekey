-- Billing money model, contract step 6 of 6: a percentage coupon's rate is
-- `basis_points` and a fixed coupon's amounts are its `coupon_amounts` rows.
-- `coupons.amount_off` and `coupons.currency` are dropped.
--
-- One transaction, with the tables locked from the first statement. A coupon
-- whose discount exists only in the columns being dropped, or differs there
-- from what the new columns hold, stops the migration: nothing here copies,
-- converts or picks one.

LOCK TABLE "coupons", "coupon_amounts" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  found BIGINT;
BEGIN
  SELECT n INTO found FROM (SELECT count(*) FROM "coupons"
     WHERE ("discount_type" = 'PERCENT' AND ("basis_points" IS NULL OR "basis_points" NOT BETWEEN 0 AND 10000))
        OR ("discount_type" = 'AMOUNT' AND "basis_points" IS NOT NULL)) AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "coupons": % row(s) are percentage coupons with no rate in "basis_points" from 0 to 10000, or fixed-amount coupons that have one. This migration changed nothing; the migrations before it are applied. List them with query 17 of docs/upgrades/billing-money-model.preflight.sql. Set "basis_points" on each percentage coupon (1500 is 15 percent) and to NULL on each fixed-amount one, or delete a coupon that was never usable. Then run `prisma migrate resolve --rolled-back 20261014100006_coupon_terms_live_on_rate_and_amount_rows` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "coupons"
     WHERE "discount_type" = 'PERCENT'
       AND "basis_points" IS NOT NULL
       AND "amount_off" <> 0
       AND "amount_off" <> "basis_points") AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "coupons": % row(s) are percentage coupons whose "amount_off" holds a rate other than the one in "basis_points", so dropping "amount_off" would lose it. This migration changed nothing; the migrations before it are applied. List them with query 24 of docs/upgrades/billing-money-model.preflight.sql. Decide which rate is right for each: put it in "basis_points", then set "amount_off" to 0. Then run `prisma migrate resolve --rolled-back 20261014100006_coupon_terms_live_on_rate_and_amount_rows` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "coupons" AS c
     WHERE c."discount_type" = 'AMOUNT'
       AND c."amount_off" > 0
       AND NOT EXISTS (SELECT 1 FROM "coupon_amounts" AS ca WHERE ca."coupon_id" = c."id")) AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "coupons": % row(s) are fixed-amount coupons with no row in "coupon_amounts" (they had no currency, or one that is not three letters), so dropping "coupons"."amount_off" would lose their amount. This migration changed nothing; the migrations before it are applied. List them with query 18 of docs/upgrades/billing-money-model.preflight.sql. For each, insert a "coupon_amounts" row in the currency it discounts, as the statement beside that query shows, or delete the coupon. Then run `prisma migrate resolve --rolled-back 20261014100006_coupon_terms_live_on_rate_and_amount_rows` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "coupons" AS c
     WHERE c."discount_type" = 'AMOUNT'
       AND c."amount_off" > 0
       AND upper(c."currency") ~ '^[A-Z]{3}$'
       AND EXISTS (SELECT 1 FROM "coupon_amounts" AS ca WHERE ca."coupon_id" = c."id")
       AND NOT EXISTS (SELECT 1 FROM "coupon_amounts" AS ca
                        WHERE ca."coupon_id" = c."id" AND ca."currency" = upper(c."currency") AND ca."amount_off" = c."amount_off")) AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "coupons": % row(s) are fixed-amount coupons whose "amount_off" and "currency" match none of their rows in "coupon_amounts", so dropping the two columns would lose that amount. This migration changed nothing; the migrations before it are applied. List them with query 23 of docs/upgrades/billing-money-model.preflight.sql. Decide which is right for each: add the missing "coupon_amounts" row, or set "coupons"."amount_off" to 0 if the rows are right. Then run `prisma migrate resolve --rolled-back 20261014100006_coupon_terms_live_on_rate_and_amount_rows` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- AlterTable
ALTER TABLE "coupons" DROP COLUMN "amount_off",
DROP COLUMN "currency";

-- A percentage coupon has a rate and a fixed one has none. A CHECK is
-- invisible to Prisma, so it lives only here. `IS NOT NULL` is spelled out
-- because a CHECK passes when its expression is NULL, and a comparison with a
-- NULL rate is.
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_rate_by_kind"
  CHECK (
    ("discount_type" = 'PERCENT' AND "basis_points" IS NOT NULL AND "basis_points" BETWEEN 0 AND 10000)
    OR ("discount_type" = 'AMOUNT' AND "basis_points" IS NULL)
  );
