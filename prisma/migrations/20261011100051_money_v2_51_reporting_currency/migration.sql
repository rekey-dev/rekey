-- Billing money model 2, step D: `billingConfig.currency` becomes
-- `billingConfig.reportingCurrency`.
--
-- Data only, so there is nothing for `prisma migrate diff` to generate. The
-- value is copied, upper-cased, where it is three letters; anything else is
-- left out and reads as the default. The old key stays in place for the units
-- that still read it and goes with the other old columns in the next release.
-- Safe to run twice: a row that already has the new key is skipped.
UPDATE "applications"
   SET "billing_config" = "billing_config" || jsonb_build_object('reportingCurrency', upper("billing_config" ->> 'currency'))
 WHERE jsonb_typeof("billing_config") = 'object'
   AND NOT ("billing_config" ? 'reportingCurrency')
   AND upper("billing_config" ->> 'currency') ~ '^[A-Z]{3}$';
