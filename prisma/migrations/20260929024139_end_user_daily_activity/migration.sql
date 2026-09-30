-- AlterTable
ALTER TABLE "end_users" ADD COLUMN     "activity_bits" bit(63),
ADD COLUMN     "last_active_on" DATE;

-- CreateIndex
CREATE INDEX "end_users_application_id_last_active_on_idx" ON "end_users"("application_id", "last_active_on");
