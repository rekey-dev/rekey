-- UsageRecord: attribute usage to an org pool (owner+beneficiary)
ALTER TABLE "usage_records" ADD COLUMN "organization_id" TEXT;
CREATE INDEX "usage_records_organization_id_idx" ON "usage_records"("organization_id");
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
