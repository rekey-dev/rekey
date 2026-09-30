-- AlterTable
ALTER TABLE "billing_credentials" ADD COLUMN     "secrets_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing rows: the secret last changed no later than the row did.
UPDATE "billing_credentials" SET "secrets_updated_at" = "updated_at";
