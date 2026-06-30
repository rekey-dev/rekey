-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "provider" TEXT;

-- CreateTable
CREATE TABLE "billing_credentials" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "ciphertext" TEXT NOT NULL,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priority" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_credentials_application_id_enabled_idx" ON "billing_credentials"("application_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credentials_application_id_provider_key" ON "billing_credentials"("application_id", "provider");

-- AddForeignKey
ALTER TABLE "billing_credentials" ADD CONSTRAINT "billing_credentials_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: lift existing single-provider creds from applications.billing_credentials_ciphertext
-- into the new per-provider table. Provider is taken from applications.billing_config->>'provider'
-- (defaults to 'stripe' if missing). Only rows with non-null ciphertext are migrated.
INSERT INTO "billing_credentials" ("id", "application_id", "provider", "enabled", "ciphertext", "countries", "priority", "created_at", "updated_at")
SELECT
  'bc_' || replace(gen_random_uuid()::text, '-', ''),
  a.id,
  COALESCE(a.billing_config->>'provider', 'stripe'),
  true,
  a.billing_credentials_ciphertext,
  ARRAY[]::TEXT[],
  100,
  NOW(),
  NOW()
FROM "applications" a
WHERE a.billing_credentials_ciphertext IS NOT NULL
ON CONFLICT ("application_id", "provider") DO NOTHING;

-- Backfill subscriptions.provider from the application's billing_config.provider.
-- Existing rows were single-provider so this is a faithful one-shot fill.
UPDATE "subscriptions" s
SET "provider" = COALESCE(a.billing_config->>'provider', 'stripe')
FROM "applications" a
WHERE s.application_id = a.id AND s.provider IS NULL;
