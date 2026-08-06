-- AlterTable
ALTER TABLE "plan_entitlements" ADD COLUMN     "credits_per_unit" INTEGER;

-- AlterTable
ALTER TABLE "usage_records" ADD COLUMN     "credits_per_unit_applied" INTEGER;
