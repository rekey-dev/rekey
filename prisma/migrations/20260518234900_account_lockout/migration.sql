-- AlterTable
ALTER TABLE "end_users" ADD COLUMN     "failed_sign_in_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMP(3);

