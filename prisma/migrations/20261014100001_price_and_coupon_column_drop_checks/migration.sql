-- Billing money model, contract step 1 of 6: nothing is changed here. The
-- five migrations after this one add constraints and drop the columns the
-- price rows replaced. Steps 2 to 4 leave an API instance of the previous
-- version working; steps 5 and 6 and the lockout column drop after them do
-- not, so they run last and together. This one looks for every row that
-- would stop any of them, so a deployment that cannot be migrated is refused
-- before the contract changes anything, with every reason in one message.
--
-- No value is guessed for a row that cannot be migrated. Each of the next
-- migrations repeats its own checks under a lock, because a row can still be
-- written between this file and that one.

DO $$
DECLARE
  found BIGINT;
  problems TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT n INTO found FROM (SELECT count(*) FROM "subscriptions"
     WHERE ("currency" IS NULL) <> ("unit_amount" IS NULL)
        OR ("currency" IS NULL) <> ("plan_price_id" IS NULL)) AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"subscriptions": %s row(s) have some of "plan_price_id", "currency" and "unit_amount" set and not the others, so the price they pay cannot be stated. See query 13. For each, set all three from one of the rows of its plan in "plan_prices" (the "id" and "currency" of that row, and the amount the subscriber pays), or set all three to NULL for a subscription that pays nothing.', found));
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "subscriptions" AS s
      JOIN "plan_prices" AS pp ON pp."id" = s."plan_price_id"
     WHERE pp."plan_id" <> s."plan_id") AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"subscriptions": %s row(s) name a price in "plan_price_id" that belongs to another plan. See query 12. Point each at a "plan_prices" row of its own plan in the same currency.', found));
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "subscriptions" AS s
      JOIN "plan_prices" AS pp ON pp."id" = s."plan_price_id"
     WHERE upper(s."currency") <> pp."currency") AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"subscriptions": %s row(s) record a "currency" that is not the currency of the price row they name. See query 20. For each, point "plan_price_id" at a price row of its own plan in the currency it pays, or correct its "currency".', found));
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "plans" WHERE "amount" <> 0 AND "default_price_id" IS NULL) AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"plans": %s row(s) have an "amount" and no default price row, so dropping "plans"."amount" would lose it. See query 14. For each, insert its price into "plan_prices" in a real currency and set "default_price_id" to it, as the statement beside that query shows, or set "amount" to 0 on a plan that charges no flat amount, or delete a plan nothing subscribes to.', found));
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "plans" AS p
      JOIN "plan_prices" AS dp ON dp."id" = p."default_price_id"
     WHERE dp."archived_at" IS NULL
       AND (dp."amount" <> p."amount" OR dp."currency" <> upper(p."currency"))) AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"plans": %s row(s) have an "amount" or "currency" that disagrees with their default price row, so one of the two is wrong and only the price row is kept. See query 15. Decide which is right for each and make the other match: update the "plan_prices" row, or update "plans"."amount" and "currency". A plan whose "amount" is 0 or less has no default price: set "default_price_id" to NULL.', found));
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "plans" AS p
      JOIN "plan_prices" AS dp ON dp."id" = p."default_price_id"
     WHERE dp."archived_at" IS NOT NULL) AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"plans": %s row(s) have a default price row that is archived, so nothing can be sold at it. See query 21. For each, un-archive it (set "archived_at" to NULL on that "plan_prices" row), or point "default_price_id" at a live row of the same plan.', found));
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "plans"
     WHERE "is_free" <> ("amount" = 0 AND "price_per_unit_cents" IS NULL)) AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"plans": %s row(s) have an "is_free" flag that disagrees with their "amount" and "price_per_unit_cents", which are about to be dropped. See query 16. Set "is_free" to true on a plan that charges nothing at all and to false on every other.', found));
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "plans"
     WHERE "price_per_unit_cents" IS NOT NULL
       AND (jsonb_typeof("metadata") IS DISTINCT FROM 'object'
            OR ("metadata" ? 'pricePerUnitCents' AND "metadata" -> 'pricePerUnitCents' <> to_jsonb("price_per_unit_cents")))) AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"plans": %s row(s) have a "price_per_unit_cents" that cannot be kept under "pricePerUnitCents" in "metadata": the metadata is not a JSON object, or it already holds a different value there. See query 22. For each, make "metadata" a JSON object, or correct or remove its "pricePerUnitCents" key, or set "price_per_unit_cents" to NULL if the figure is not wanted.', found));
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "plan_prices"
     WHERE NOT ("currency" = upper("currency") AND "currency" ~ '^[A-Z]{3}$')) AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"plan_prices": %s row(s) have a "currency" that is not three upper-case letters. See query 10. Correct the currency of each, or delete a row nothing refers to.', found));
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "coupons"
     WHERE ("discount_type" = 'PERCENT' AND ("basis_points" IS NULL OR "basis_points" NOT BETWEEN 0 AND 10000))
        OR ("discount_type" = 'AMOUNT' AND "basis_points" IS NOT NULL)) AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"coupons": %s row(s) are percentage coupons with no rate in "basis_points" from 0 to 10000, or fixed-amount coupons that have one. See query 17. Set "basis_points" on each percentage coupon (1500 is 15 percent) and to NULL on each fixed-amount one, or delete a coupon that was never usable.', found));
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "coupons"
     WHERE "discount_type" = 'PERCENT'
       AND "basis_points" IS NOT NULL
       AND "amount_off" <> 0
       AND "amount_off" <> "basis_points") AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"coupons": %s row(s) are percentage coupons whose "amount_off" holds a rate other than the one in "basis_points", so dropping "amount_off" would lose it. See query 24. Decide which rate is right for each: put it in "basis_points", then set "amount_off" to 0.', found));
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "coupons" AS c
     WHERE c."discount_type" = 'AMOUNT'
       AND c."amount_off" > 0
       AND NOT EXISTS (SELECT 1 FROM "coupon_amounts" AS ca WHERE ca."coupon_id" = c."id")) AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"coupons": %s row(s) are fixed-amount coupons with no row in "coupon_amounts" (they had no currency, or one that is not three letters), so dropping "coupons"."amount_off" would lose their amount. See query 18. For each, insert a "coupon_amounts" row in the currency it discounts, as the statement beside that query shows, or delete the coupon.', found));
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "coupons" AS c
     WHERE c."discount_type" = 'AMOUNT'
       AND c."amount_off" > 0
       AND upper(c."currency") ~ '^[A-Z]{3}$'
       AND EXISTS (SELECT 1 FROM "coupon_amounts" AS ca WHERE ca."coupon_id" = c."id")
       AND NOT EXISTS (SELECT 1 FROM "coupon_amounts" AS ca
                        WHERE ca."coupon_id" = c."id" AND ca."currency" = upper(c."currency") AND ca."amount_off" = c."amount_off")) AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"coupons": %s row(s) are fixed-amount coupons whose "amount_off" and "currency" match none of their rows in "coupon_amounts", so dropping the two columns would lose that amount. See query 23. Decide which is right for each: add the missing "coupon_amounts" row, or set "coupons"."amount_off" to 0 if the rows are right.', found));
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "applications"
     WHERE jsonb_typeof("billing_config") = 'object'
       AND "billing_config" ? 'currency'
       AND NOT (jsonb_typeof("billing_config" -> 'reportingCurrency') IS NOT DISTINCT FROM 'string'
                AND "billing_config" ->> 'reportingCurrency' ~ '^[A-Za-z]{3}$')) AS t(n);
  IF found > 0 THEN
    problems := array_append(problems, format('"applications": %s row(s) have a "currency" key in "billing_config" and no three-letter "reportingCurrency" to replace it. See query 19. For each, set "reportingCurrency" to the ISO 4217 code that was meant, or remove the "currency" key if the default is right.', found));
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'The 2.2.0 money model cannot be completed on this database. This migration changed nothing; the migrations before it are applied. Query numbers are in docs/upgrades/billing-money-model.preflight.sql. %  Correct each, then run `prisma migrate resolve --rolled-back 20261014100001_price_and_coupon_column_drop_checks` and deploy again.', array_to_string(problems, ' ')
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
