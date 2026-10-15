-- Billing money model, contract step 5 of 6: a plan's price lives on its
-- default price row and nowhere else. `plans.amount`, `plans.currency` and
-- `plans.price_per_unit_cents` are dropped.
--
-- One transaction, with both tables locked from the first statement. The
-- checks refuse a plan whose price would be lost with the columns, or whose
-- columns and price row disagree: this file cannot know which of the two an
-- operator meant, so it does not choose.

LOCK TABLE "plans", "plan_prices" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  found BIGINT;
BEGIN
  SELECT n INTO found FROM (SELECT count(*) FROM "plans" WHERE "amount" <> 0 AND "default_price_id" IS NULL) AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "plans": % row(s) have an "amount" and no default price row, so dropping "plans"."amount" would lose it. This migration changed nothing; the migrations before it are applied. List them with query 14 of docs/upgrades/billing-money-model.preflight.sql. For each, insert its price into "plan_prices" in a real currency and set "default_price_id" to it, as the statement beside that query shows, or set "amount" to 0 on a plan that charges no flat amount, or delete a plan nothing subscribes to. Then run `prisma migrate resolve --rolled-back 20261014100005_plan_prices_live_on_price_rows` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "plans" AS p
      JOIN "plan_prices" AS dp ON dp."id" = p."default_price_id"
     WHERE dp."archived_at" IS NULL
       AND (dp."amount" <> p."amount" OR dp."currency" <> upper(p."currency"))) AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "plans": % row(s) have an "amount" or "currency" that disagrees with their default price row, so one of the two is wrong and only the price row is kept. This migration changed nothing; the migrations before it are applied. List them with query 15 of docs/upgrades/billing-money-model.preflight.sql. Decide which is right for each and make the other match: update the "plan_prices" row, or update "plans"."amount" and "currency". A plan whose "amount" is 0 or less has no default price: set "default_price_id" to NULL. Then run `prisma migrate resolve --rolled-back 20261014100005_plan_prices_live_on_price_rows` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "plans" AS p
      JOIN "plan_prices" AS dp ON dp."id" = p."default_price_id"
     WHERE dp."archived_at" IS NOT NULL) AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "plans": % row(s) have a default price row that is archived, so nothing can be sold at it. This migration changed nothing; the migrations before it are applied. List them with query 21 of docs/upgrades/billing-money-model.preflight.sql. For each, un-archive it (set "archived_at" to NULL on that "plan_prices" row), or point "default_price_id" at a live row of the same plan. Then run `prisma migrate resolve --rolled-back 20261014100005_plan_prices_live_on_price_rows` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "plans"
     WHERE "is_free" <> ("amount" = 0 AND "price_per_unit_cents" IS NULL)) AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "plans": % row(s) have an "is_free" flag that disagrees with their "amount" and "price_per_unit_cents", which are about to be dropped. This migration changed nothing; the migrations before it are applied. List them with query 16 of docs/upgrades/billing-money-model.preflight.sql. Set "is_free" to true on a plan that charges nothing at all and to false on every other. Then run `prisma migrate resolve --rolled-back 20261014100005_plan_prices_live_on_price_rows` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "plans"
     WHERE "price_per_unit_cents" IS NOT NULL
       AND (jsonb_typeof("metadata") IS DISTINCT FROM 'object'
            OR ("metadata" ? 'pricePerUnitCents' AND "metadata" -> 'pricePerUnitCents' <> to_jsonb("price_per_unit_cents")))) AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "plans": % row(s) have a "price_per_unit_cents" that cannot be kept under "pricePerUnitCents" in "metadata": the metadata is not a JSON object, or it already holds a different value there. This migration changed nothing; the migrations before it are applied. List them with query 22 of docs/upgrades/billing-money-model.preflight.sql. For each, make "metadata" a JSON object, or correct or remove its "pricePerUnitCents" key, or set "price_per_unit_cents" to NULL if the figure is not wanted. Then run `prisma migrate resolve --rolled-back 20261014100005_plan_prices_live_on_price_rows` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "plan_prices"
     WHERE NOT ("currency" = upper("currency") AND "currency" ~ '^[A-Z]{3}$')) AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "plan_prices": % row(s) have a "currency" that is not three upper-case letters. This migration changed nothing; the migrations before it are applied. List them with query 10 of docs/upgrades/billing-money-model.preflight.sql. Correct the currency of each, or delete a row nothing refers to. Then run `prisma migrate resolve --rolled-back 20261014100005_plan_prices_live_on_price_rows` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- The per-unit figure an operator entered moves to the plan's own metadata,
-- under `pricePerUnitCents`, exactly as stored. Nothing charges it and
-- nothing reads it; it is kept because an operator typed it. The check above
-- has refused a plan whose metadata could not take it.
UPDATE "plans"
   SET "metadata" = "metadata" || jsonb_build_object('pricePerUnitCents', "price_per_unit_cents")
 WHERE "price_per_unit_cents" IS NOT NULL;

-- Added NOT VALID in money_v2_01 so rows that already broke it did not stop
-- that deploy. Every row satisfies it now.
ALTER TABLE "plan_prices" VALIDATE CONSTRAINT "plan_prices_currency_code";

-- AlterTable
ALTER TABLE "plans" DROP COLUMN "amount",
DROP COLUMN "currency",
DROP COLUMN "price_per_unit_cents";

-- A free plan has no price row. A CHECK is invisible to Prisma, so it lives
-- only here.
ALTER TABLE "plans" ADD CONSTRAINT "plans_free_has_no_price"
  CHECK (NOT ("is_free" AND "default_price_id" IS NOT NULL));
