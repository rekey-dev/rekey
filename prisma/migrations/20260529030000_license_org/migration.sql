-- License: pool seats to an org beneficiary (owner+beneficiary, ORG_BILLING §3)
ALTER TABLE "licenses" ADD COLUMN "organization_id" TEXT;
CREATE INDEX "licenses_organization_id_idx" ON "licenses"("organization_id");
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
