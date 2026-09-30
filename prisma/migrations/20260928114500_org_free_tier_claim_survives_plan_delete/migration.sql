-- DropForeignKey
ALTER TABLE "organization_free_tier_claims" DROP CONSTRAINT "organization_free_tier_claims_plan_id_fkey";

-- AlterTable
ALTER TABLE "organization_free_tier_claims" ALTER COLUMN "plan_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "organization_free_tier_claims" ADD CONSTRAINT "organization_free_tier_claims_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
