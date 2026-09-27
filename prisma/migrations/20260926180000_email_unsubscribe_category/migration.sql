-- AlterTable
ALTER TABLE "custom_email_templates" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "email_suppressions" ADD COLUMN     "category" TEXT;

