-- Idempotency keys on usage records were scoped (meter, key) with no subject,
-- so one subject's key returned another subject's record. On a priced meter
-- that is consumption nobody paid for.
--
-- Mirrors credit_balances.subject_key: a non-null identity, because Postgres
-- treats NULLs as distinct and a compound unique over the nullable subject
-- columns would silently stop deduplicating app-level records.

-- 1. Add the column. The DEFAULT fills existing rows with 'app', which is only
--    correct for genuinely subject-less usage, so step 2 restates the rest.
ALTER TABLE "usage_records" ADD COLUMN "subject_key" TEXT NOT NULL DEFAULT 'app';

-- 2. Backfill from the subject columns that are already there.
UPDATE "usage_records"
   SET "subject_key" = CASE
     WHEN "organization_id" IS NOT NULL THEN 'o:' || "organization_id"
     WHEN "end_user_id"     IS NOT NULL THEN 'u:' || "end_user_id"
     ELSE 'app'
   END;

-- 3. Swap the uniqueness. The new index is strictly weaker than the old one —
--    every pair unique under (meter, key) stays unique with a third column
--    added — so this cannot fail on existing data.
DROP INDEX IF EXISTS "usage_records_meter_id_idempotency_key_key";
CREATE UNIQUE INDEX "usage_records_meter_id_subject_key_idempotency_key_key"
    ON "usage_records"("meter_id", "subject_key", "idempotency_key");
