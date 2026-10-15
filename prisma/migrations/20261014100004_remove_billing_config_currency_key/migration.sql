-- Billing money model, contract step 4 of 6: `billingConfig.currency` is
-- removed. `reportingCurrency` replaced it in money_v2_51 and nothing reads
-- the old key.
--
-- Data only, so there is nothing for `prisma migrate diff` to generate. The
-- old key is removed only where a three-letter `reportingCurrency` stands in
-- its place: money_v2_51 copied none that was not three letters, and such a
-- value is refused here, not dropped.

LOCK TABLE "applications" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  found BIGINT;
BEGIN
  SELECT n INTO found FROM (SELECT count(*) FROM "applications"
     WHERE jsonb_typeof("billing_config") = 'object'
       AND "billing_config" ? 'currency'
       AND NOT (jsonb_typeof("billing_config" -> 'reportingCurrency') IS NOT DISTINCT FROM 'string'
                AND "billing_config" ->> 'reportingCurrency' ~ '^[A-Za-z]{3}$')) AS t(n);
  IF found > 0 THEN
    RAISE EXCEPTION 'Table "applications": % row(s) have a "currency" key in "billing_config" and no three-letter "reportingCurrency" to replace it. This migration changed nothing; the migrations before it are applied. List them with query 19 of docs/upgrades/billing-money-model.preflight.sql. For each, set "reportingCurrency" to the ISO 4217 code that was meant, or remove the "currency" key if the default is right. Then run `prisma migrate resolve --rolled-back 20261014100004_remove_billing_config_currency_key` and deploy again.', found
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

UPDATE "applications"
   SET "billing_config" = "billing_config" - 'currency'
 WHERE jsonb_typeof("billing_config") = 'object'
   AND "billing_config" ? 'currency';
