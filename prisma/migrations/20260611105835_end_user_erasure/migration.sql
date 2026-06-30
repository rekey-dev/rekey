-- AlterTable
ALTER TABLE "end_users" ADD COLUMN     "erased_at" TIMESTAMP(3),
ADD COLUMN     "erased_by" TEXT;
