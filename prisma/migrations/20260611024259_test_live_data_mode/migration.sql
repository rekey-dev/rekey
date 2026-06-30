-- CreateEnum
CREATE TYPE "DataMode" AS ENUM ('TEST', 'LIVE');

-- AlterTable
ALTER TABLE "end_users" ADD COLUMN     "mode" "DataMode" NOT NULL DEFAULT 'LIVE';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "mode" "DataMode" NOT NULL DEFAULT 'LIVE';

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "mode" "DataMode" NOT NULL DEFAULT 'LIVE';

-- CreateIndex
CREATE INDEX "end_users_application_id_mode_idx" ON "end_users"("application_id", "mode");

-- CreateIndex
CREATE INDEX "payments_application_id_mode_idx" ON "payments"("application_id", "mode");

-- CreateIndex
CREATE INDEX "subscriptions_application_id_mode_idx" ON "subscriptions"("application_id", "mode");
