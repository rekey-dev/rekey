-- Data only. Names the price row each subscription pays, so that every
-- subscription the backfill can answer for has all three of `plan_price_id`,
-- `currency` and `unit_amount`, or none of them. No row is deleted, and no
-- amount a subscription pays is changed.
--
-- Nothing enforces that state yet: the constraint ships in step Z
-- (docs/specs/billing-money-model.step-z.sql), which runs the linking
-- statements below again first.
--
-- Assumes:
--   - Migration money_v2_04 has run, so a plan that charges a flat amount in
--     a three-letter currency has a default price row.
--   - A subscription's `currency` and `unit_amount` are what it pays, and stay
--     as they are. Only the link to a price row is added, always to a price of
--     the subscription's own plan.
--   - A PENDING subscription with no price has paid nothing yet and takes its
--     price when its checkout completes. A subscription on a plan at amount 0
--     has no price to take.
--   - Any other subscription with no price (a grant, an import, a row from
--     before prices were recorded) has been following its plan, so it takes
--     the plan's default price, in the currency the price row is written in.
--   - A subscription whose currency is not three letters is left as it is.
--
-- Every statement is guarded by the state it repairs, so a second run changes
-- nothing and a price newer code has written is kept.

-- A price link whose amounts were lost: read them back from the price row.
UPDATE "subscriptions" AS s
   SET "currency" = pp."currency", "unit_amount" = pp."amount"
  FROM "plan_prices" AS pp
 WHERE pp."id" = s."plan_price_id"
   AND s."currency" IS NULL;

-- A recorded price of zero on a plan that charges no flat amount (free, or
-- metered at amount 0) is no price: no price row can stand for it. A zero on
-- a plan that does charge is a subscriber who pays nothing, and is kept.
UPDATE "subscriptions" AS s
   SET "currency" = NULL, "unit_amount" = NULL
  FROM "plans" AS p
 WHERE p."id" = s."plan_id"
   AND p."amount" <= 0
   AND s."plan_price_id" IS NULL
   AND s."unit_amount" IS NOT NULL
   AND s."unit_amount" <= 0;

-- A subscription paying in a currency its plan no longer has a price in (the
-- plan was re-priced while unregistered). The price it pays still existed, so
-- it gets an archived row: nothing new can be sold at it.
INSERT INTO "plan_prices" (
  "id", "application_id", "plan_id", "currency", "amount", "countries",
  "metadata", "registration_status", "archived_at", "created_at", "updated_at"
)
SELECT
  'pp_' || md5(s."plan_id" || ':' || upper(s."currency") || ':archived'),
  p."application_id",
  s."plan_id",
  upper(s."currency"),
  max(s."unit_amount"),
  ARRAY[]::TEXT[],
  '{}'::jsonb,
  'NOT_REQUIRED',
  now(),
  now(),
  now()
FROM "subscriptions" AS s
JOIN "plans" AS p ON p."id" = s."plan_id"
WHERE s."plan_price_id" IS NULL
  AND s."currency" IS NOT NULL
  AND s."unit_amount" > 0
  AND upper(s."currency") ~ '^[A-Z]{3}$'
  AND NOT EXISTS (
    SELECT 1 FROM "plan_prices" AS pp
     WHERE pp."plan_id" = s."plan_id" AND pp."currency" = upper(s."currency")
  )
GROUP BY s."plan_id", p."application_id", upper(s."currency");

-- Link by plan and currency. A live price is preferred to an archived one.
UPDATE "subscriptions" AS s
   SET "plan_price_id" = (
     SELECT pp."id" FROM "plan_prices" AS pp
      WHERE pp."plan_id" = s."plan_id" AND pp."currency" = upper(s."currency")
      ORDER BY (pp."archived_at" IS NULL) DESC, pp."created_at" ASC, pp."id" ASC
      LIMIT 1
   )
 WHERE s."plan_price_id" IS NULL
   AND s."currency" IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM "plan_prices" AS pp
      WHERE pp."plan_id" = s."plan_id" AND pp."currency" = upper(s."currency")
   );

-- A subscriber who pays nothing, in a currency the plan has no price in: the
-- default price, still at nothing. Zero is the same in any currency, so the
-- currency is written as the price row has it.
UPDATE "subscriptions" AS s
   SET "plan_price_id" = pp."id", "currency" = pp."currency"
  FROM "plans" AS p
  JOIN "plan_prices" AS pp ON pp."id" = p."default_price_id" AND pp."plan_id" = p."id"
 WHERE p."id" = s."plan_id"
   AND s."plan_price_id" IS NULL
   AND s."currency" IS NOT NULL
   AND s."unit_amount" = 0;

-- No price at all, on a plan that charges, and past PENDING: the default price.
UPDATE "subscriptions" AS s
   SET "plan_price_id" = pp."id", "currency" = pp."currency", "unit_amount" = pp."amount"
  FROM "plans" AS p
  JOIN "plan_prices" AS pp ON pp."id" = p."default_price_id" AND pp."plan_id" = p."id"
 WHERE p."id" = s."plan_id"
   AND s."currency" IS NULL
   AND s."status" <> 'PENDING';
