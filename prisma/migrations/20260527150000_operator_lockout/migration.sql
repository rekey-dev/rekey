-- AlterTable
ALTER TABLE "tenant_users" ADD COLUMN     "failed_sign_in_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMP(3);
