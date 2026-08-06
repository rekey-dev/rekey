-- AlterTable
ALTER TABLE "usage_meters" ADD COLUMN     "credits_per_unit" INTEGER;

-- AlterTable
ALTER TABLE "usage_records" ADD COLUMN     "credits_charged" INTEGER;
