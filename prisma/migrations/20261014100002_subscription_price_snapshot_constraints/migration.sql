-- Billing money model, contract step 2 of 6: a subscription's price is three
-- columns that are all set or all null, and the price row it names is one of
-- its own plan's and cannot be deleted from under it.
--
-- Prisma runs this file as one transaction. The lock is taken first and held
-- to the end, so no subscription or price is written between the checks and
-- the constraints. A row that cannot satisfy them stops the migration and
-- the transaction leaves the database as it was.
--
-- No constraint ties a subscription's `currency` to its price row's: that
-- would need the currency in the foreign key. It is checked once here, and
-- from then on it holds because `billing/subscription-snapshot.ts` is the
-- only writer of the three columns and takes the currency from the row.

LOCK TABLE "subscriptions", "plan_prices" IN SHARE ROW EXCLUSIVE MODE;

-- The same currency in another letter case is the same currency. Written as
-- the price row has it, so the two are equal and not only alike.
UPDATE "subscriptions" AS s
   SET "currency" = pp."currency"
  FROM "plan_prices" AS pp
 WHERE pp."id" = s."plan_price_id"
   AND s."currency" <> pp."currency"
   AND upper(s."currency") = pp."currency";

DO $$
DECLARE
  found BIGINT;
BEGIN
  SELECT n INTO found FROM (SELECT count(*) FROM "subscriptions"
     WHERE ("currency" IS NULL) <> ("unit_amount" IS NULL)
        OR ("currency" IS NULL) <> ("plan_price_id" IS NULL)) AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "subscriptions": % row(s) have some of "plan_price_id", "currency" and "unit_amount" set and not the others, so the price they pay cannot be stated. This migration changed nothing; the migrations before it are applied. List them with query 13 of docs/upgrades/billing-money-model.preflight.sql. For each, set all three from one of the rows of its plan in "plan_prices" (the "id" and "currency" of that row, and the amount the subscriber pays), or set all three to NULL for a subscription that pays nothing. Then run `prisma migrate resolve --rolled-back 20261014100002_subscription_price_snapshot_constraints` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "subscriptions" AS s
      JOIN "plan_prices" AS pp ON pp."id" = s."plan_price_id"
     WHERE pp."plan_id" <> s."plan_id") AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "subscriptions": % row(s) name a price in "plan_price_id" that belongs to another plan. This migration changed nothing; the migrations before it are applied. List them with query 12 of docs/upgrades/billing-money-model.preflight.sql. Point each at a "plan_prices" row of its own plan in the same currency. Then run `prisma migrate resolve --rolled-back 20261014100002_subscription_price_snapshot_constraints` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT n INTO found FROM (SELECT count(*) FROM "subscriptions" AS s
      JOIN "plan_prices" AS pp ON pp."id" = s."plan_price_id"
     WHERE upper(s."currency") <> pp."currency") AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "subscriptions": % row(s) record a "currency" that is not the currency of the price row they name. This migration changed nothing; the migrations before it are applied. List them with query 20 of docs/upgrades/billing-money-model.preflight.sql. For each, point "plan_price_id" at a price row of its own plan in the currency it pays, or correct its "currency". Then run `prisma migrate resolve --rolled-back 20261014100002_subscription_price_snapshot_constraints` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- Replaces `subscriptions_price_pair`, which tied only currency and amount.
-- A CHECK is invisible to Prisma, so it lives only here.
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_price_pair";

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_price_snapshot"
  CHECK (
    ("currency" IS NULL) = ("unit_amount" IS NULL)
    AND ("currency" IS NULL) = ("plan_price_id" IS NULL)
  );

-- DropForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_plan_price_id_fkey";

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_price_id_plan_id_fkey" FOREIGN KEY ("plan_price_id", "plan_id") REFERENCES "plan_prices"("id", "plan_id") ON DELETE RESTRICT ON UPDATE CASCADE;
