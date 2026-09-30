-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "activity_tracked_since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "end_users" ADD COLUMN     "last_sign_in_via" TEXT,
ADD COLUMN     "last_signed_in_at" TIMESTAMP(3),
ADD COLUMN     "sign_in_count" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "end_users_application_id_last_signed_in_at_idx" ON "end_users"("application_id", "last_signed_in_at");

