-- Grandfather existing billing-configured apps to billing_config.enabled = true.
-- New apps default to false (BillingConfigSchema). Apps with provider credentials
-- set OR any plan defined are considered already-using-billing.
UPDATE "applications"
SET "billing_config" = jsonb_set("billing_config", '{enabled}', 'true'::jsonb)
WHERE "billing_credentials_ciphertext" IS NOT NULL
   OR "id" IN (SELECT DISTINCT "application_id" FROM "plans");
