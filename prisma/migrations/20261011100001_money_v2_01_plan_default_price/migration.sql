-- Billing money model 2, expand step 1 of 3: a plan's default price becomes a
-- row. Nothing is renamed or dropped; `plans.amount` and `plans.currency` stay.

-- Refuses to start while any money is stored in HUF, TWD, ISK, UGX or MGA.
-- This release changes how a stored amount in those currencies is sent to a
-- provider (PayPal: HUF and TWD; Stripe: ISK, UGX and MGA), and nothing can
-- rescale a row without knowing which provider it was written for. Runs
-- before any change, so a refusal leaves the database as it was.
DO $$
DECLARE
  found TEXT;
BEGIN
  SELECT string_agg(t."name" || ' (' || t."n" || ')', ', ' ORDER BY t."name") INTO found
    FROM (
      SELECT 'plans' AS "name", count(*) AS "n" FROM "plans"
       WHERE "amount" > 0 AND upper("currency") IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
      UNION ALL
      SELECT 'plan_prices', count(*) FROM "plan_prices"
       WHERE upper("currency") IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
      UNION ALL
      SELECT 'subscriptions', count(*) FROM "subscriptions"
       WHERE "unit_amount" IS NOT NULL AND upper("currency") IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
      UNION ALL
      SELECT 'payments', count(*) FROM "payments"
       WHERE upper("currency") IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
      UNION ALL
      SELECT 'checkout_sessions', count(*) FROM "checkout_sessions"
       WHERE upper("currency") IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
      UNION ALL
      SELECT 'coupons', count(*) FROM "coupons"
       WHERE "discount_type" = 'AMOUNT' AND upper("currency") IN ('HUF', 'TWD', 'ISK', 'UGX', 'MGA')
    ) AS t
   WHERE t."n" > 0;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'Money model 2 cannot migrate money stored in HUF, TWD, ISK, UGX or MGA. Rows found: %. Nothing was changed. Run query 3 of docs/specs/billing-money-model.preflight.sql to list them, rescale or remove each by hand against its provider, then run `prisma migrate resolve --rolled-back 20261011100001_money_v2_01_plan_default_price` and deploy again.', found
      USING ERRCODE = 'feature_not_supported';
  END IF;
END
$$;

-- CreateEnum
CREATE TYPE "PlanLocalPrices" AS ENUM ('INHERIT', 'TRUSTED', 'OFF');

-- AlterTable
ALTER TABLE "plan_prices" ADD COLUMN     "archived_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "default_price_id" TEXT,
ADD COLUMN     "is_free" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "local_prices" "PlanLocalPrices" NOT NULL DEFAULT 'INHERIT';

-- DropIndex
DROP INDEX "plan_prices_plan_id_currency_key";

-- CreateIndex
CREATE INDEX "plan_prices_plan_id_currency_idx" ON "plan_prices"("plan_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "plan_prices_id_plan_id_key" ON "plan_prices"("id", "plan_id");

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_default_price_id_id_fkey" FOREIGN KEY ("default_price_id", "id") REFERENCES "plan_prices"("id", "plan_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- One LIVE price per plan and currency. An archived price keeps its row for
-- the subscriptions and payments that refer to it, and must not stop the plan
-- being priced in that currency again.
--
-- Prisma 6 cannot describe a partial index, and `prisma migrate diff` ignores
-- one, so it lives only here. schema.prisma documents it on PlanPrice.
CREATE UNIQUE INDEX "plan_prices_plan_id_currency_live_key"
  ON "plan_prices" ("plan_id", "currency")
  WHERE "archived_at" IS NULL;

-- A price is money. A plan that charges nothing has no price row.
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_amount_positive" CHECK ("amount" > 0);

-- A price's currency is three upper-case letters, so `usd` cannot sit beside
-- `USD` as a second live price. NOT VALID: it holds for every row written or
-- changed from here on, and a row that already breaks it does not stop the
-- deploy. Query 10 of the preflight lists those.
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_currency_code"
  CHECK ("currency" = upper("currency") AND "currency" ~ '^[A-Z]{3}$') NOT VALID;

-- Every price of a credit pack grants the same credits, so a purchasing-power
-- price is cheap credits. Credit plans start out believing only a trusted
-- country. Run once, here, while no operator can have chosen otherwise.
UPDATE "plans" SET "local_prices" = 'TRUSTED' WHERE "kind" = 'CREDIT';
