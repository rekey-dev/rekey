-- AlterTable
ALTER TABLE "end_users" ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'user';

-- CreateIndex
CREATE INDEX "end_users_application_id_role_idx" ON "end_users"("application_id", "role");
