-- AlterTable
ALTER TABLE "licenses" ADD COLUMN     "entitlement_key" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "licenses_application_id_plan_id_entitlement_key_idx" ON "licenses"("application_id", "plan_id", "entitlement_key");
