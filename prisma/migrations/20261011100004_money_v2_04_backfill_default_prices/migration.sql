-- Data only. Gives every plan that charges a flat amount a price row in its
-- own currency, at the plan's amount and holding the plan's provider
-- registrations, and points `plans.default_price_id` at it.
--
-- Assumes:
--   - `plans.amount` and `plans.currency` are the plan's default price, for
--     archived plans as much as live ones.
--   - A provider registration is whatever sits under the `stripe`, `paypal`
--     and `razorpay` keys of `plans.metadata`. Each is copied onto the price
--     row exactly as stored: same ids, same `mode`, and no `mode` where none
--     was recorded. Stamping one would record a guess as a fact, and a changed
--     id would make the provider mint a second plan.
--   - `plans.metadata` is left as it is. The API still reads it.
--   - A currency is written in upper case. A plan whose currency is not three
--     letters gets no price row and no default: query 10 of the preflight
--     lists those, and nothing here guesses what was meant.
--
-- Every statement that prices a plan is guarded by the plan having no default
-- price yet, so a second run changes nothing and a default the API has since
-- written or replaced is never touched.

-- A price stored as `usd` becomes `USD`. Where the plan already has a live
-- price in that currency the other-case row is archived, so one stays live.
UPDATE "plan_prices" AS pp
   SET "currency" = upper(pp."currency"),
       "archived_at" = CASE WHEN ranked."first_of_currency" THEN pp."archived_at" ELSE coalesce(pp."archived_at", now()) END
  FROM (
    SELECT "id",
           row_number() OVER (
             PARTITION BY "plan_id", upper("currency")
             ORDER BY ("archived_at" IS NULL) DESC, ("currency" = upper("currency")) DESC, "created_at" ASC, "id" ASC
           ) = 1 AS "first_of_currency"
      FROM "plan_prices"
  ) AS ranked
 WHERE ranked."id" = pp."id"
   AND pp."currency" <> upper(pp."currency")
   AND upper(pp."currency") ~ '^[A-Z]{3}$';

-- A price belongs to its plan's Application.
UPDATE "plan_prices" AS pp
   SET "application_id" = p."application_id"
  FROM "plans" AS p
 WHERE p."id" = pp."plan_id"
   AND pp."application_id" <> p."application_id"
   AND pp."currency" ~ '^[A-Z]{3}$';

-- A live price in the plan's own currency at another amount is not what the
-- plan charges. It is archived, so the row inserted below is the default.
UPDATE "plan_prices" AS pp
   SET "archived_at" = now()
  FROM "plans" AS p
 WHERE p."id" = pp."plan_id"
   AND p."default_price_id" IS NULL
   AND p."amount" > 0
   AND upper(p."currency") ~ '^[A-Z]{3}$'
   AND pp."currency" = upper(p."currency")
   AND pp."archived_at" IS NULL
   AND pp."amount" <> p."amount";

INSERT INTO "plan_prices" (
  "id", "application_id", "plan_id", "currency", "amount", "countries",
  "metadata", "registration_status", "registration_error", "created_at", "updated_at"
)
SELECT
  'pp_' || replace(gen_random_uuid()::text, '-', ''),
  p."application_id",
  p."id",
  upper(p."currency"),
  p."amount",
  ARRAY[]::TEXT[],
  '{}'::jsonb,
  p."registration_status",
  p."registration_error",
  p."created_at",
  now()
FROM "plans" AS p
WHERE p."default_price_id" IS NULL
  AND p."amount" > 0
  AND upper(p."currency") ~ '^[A-Z]{3}$'
  AND NOT EXISTS (
    SELECT 1 FROM "plan_prices" AS pp
     WHERE pp."plan_id" = p."id"
       AND pp."currency" = upper(p."currency")
       AND pp."archived_at" IS NULL
  );

-- The plan's registrations go onto the row about to become its default,
-- whether it was inserted above or was already there at the plan's amount.
UPDATE "plan_prices" AS pp
   SET "metadata" = coalesce(
         (SELECT jsonb_object_agg(k."key", k."value")
            FROM jsonb_each(CASE WHEN jsonb_typeof(p."metadata") = 'object' THEN p."metadata" ELSE '{}'::jsonb END) AS k
           WHERE k."key" IN ('stripe', 'paypal', 'razorpay')),
         '{}'::jsonb
       ),
       "registration_status" = p."registration_status",
       "registration_error" = p."registration_error"
  FROM "plans" AS p
 WHERE p."id" = pp."plan_id"
   AND p."default_price_id" IS NULL
   AND p."amount" > 0
   AND pp."currency" = upper(p."currency")
   AND pp."archived_at" IS NULL
   AND pp."amount" = p."amount";

UPDATE "plans" AS p
   SET "default_price_id" = pp."id"
  FROM "plan_prices" AS pp
 WHERE pp."plan_id" = p."id"
   AND pp."currency" = upper(p."currency")
   AND pp."archived_at" IS NULL
   AND pp."amount" = p."amount"
   AND p."amount" > 0
   AND p."default_price_id" IS NULL;
