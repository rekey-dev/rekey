-- CreateEnum
CREATE TYPE "PlanKind" AS ENUM ('SUBSCRIPTION', 'LICENSE', 'USAGE');

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "kind" "PlanKind" NOT NULL DEFAULT 'SUBSCRIPTION',
ADD COLUMN     "license_duration_days" INTEGER,
ADD COLUMN     "license_kind" "LicenseKind",
ADD COLUMN     "license_seats_allowed" INTEGER,
ADD COLUMN     "meter_slug" TEXT,
ADD COLUMN     "price_per_unit_cents" INTEGER;
