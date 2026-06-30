-- Subscription beneficiary org (owner+beneficiary model)
ALTER TABLE "subscriptions" ADD COLUMN "beneficiary_org_id" TEXT;
CREATE INDEX "subscriptions_beneficiary_org_id_idx" ON "subscriptions"("beneficiary_org_id");
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_beneficiary_org_id_fkey" FOREIGN KEY ("beneficiary_org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreditBalance: polymorphic subject (user | org) keyed by subject_key
ALTER TABLE "credit_balances" ADD COLUMN "organization_id" TEXT;
ALTER TABLE "credit_balances" ADD COLUMN "subject_key" TEXT;
ALTER TABLE "credit_balances" ALTER COLUMN "end_user_id" DROP NOT NULL;
UPDATE "credit_balances" SET "subject_key" = 'u:' || "end_user_id" WHERE "subject_key" IS NULL;
ALTER TABLE "credit_balances" ALTER COLUMN "subject_key" SET NOT NULL;
DROP INDEX "credit_balances_application_id_end_user_id_key";
CREATE UNIQUE INDEX "credit_balances_application_id_subject_key_key" ON "credit_balances"("application_id", "subject_key");
ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreditLedger: polymorphic subject
ALTER TABLE "credit_ledger" ADD COLUMN "organization_id" TEXT;
ALTER TABLE "credit_ledger" ADD COLUMN "subject_key" TEXT;
ALTER TABLE "credit_ledger" ALTER COLUMN "end_user_id" DROP NOT NULL;
UPDATE "credit_ledger" SET "subject_key" = 'u:' || "end_user_id" WHERE "subject_key" IS NULL;
ALTER TABLE "credit_ledger" ALTER COLUMN "subject_key" SET NOT NULL;
DROP INDEX "credit_ledger_application_id_end_user_id_idx";
CREATE INDEX "credit_ledger_application_id_subject_key_idx" ON "credit_ledger"("application_id", "subject_key");
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
