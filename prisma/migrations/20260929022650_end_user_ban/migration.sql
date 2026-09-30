-- AlterTable
ALTER TABLE "end_users" ADD COLUMN     "ban_reason" TEXT,
ADD COLUMN     "banned_at" TIMESTAMP(3),
ADD COLUMN     "banned_by" TEXT;
