-- CreateEnum
CREATE TYPE "LicenseKind" AS ENUM ('PERPETUAL', 'TIMED', 'SEATS');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "billing_credentials_ciphertext" TEXT,
ADD COLUMN     "oauth_config" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "oauth_credentials_ciphertext" TEXT;

-- CreateTable
CREATE TABLE "oauth_identities" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_credentials" (
    "id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "backup_codes_ciphertext" TEXT NOT NULL,
    "enrolled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mfa_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_mfa_credentials" (
    "id" TEXT NOT NULL,
    "tenant_user_id" TEXT NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "backup_codes_ciphertext" TEXT NOT NULL,
    "enrolled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_mfa_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licenses" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "plan_id" TEXT,
    "kind" "LicenseKind" NOT NULL,
    "status" "LicenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "seats_allowed" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_activations" (
    "id" TEXT NOT NULL,
    "license_id" TEXT NOT NULL,
    "machine_fingerprint" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "label" TEXT,

    CONSTRAINT "license_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_meters" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_meters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "meter_id" TEXT NOT NULL,
    "end_user_id" TEXT,
    "quantity" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "oauth_identities_application_id_idx" ON "oauth_identities"("application_id");

-- CreateIndex
CREATE INDEX "oauth_identities_end_user_id_idx" ON "oauth_identities"("end_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_identities_provider_provider_account_id_key" ON "oauth_identities"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_credentials_end_user_id_key" ON "mfa_credentials"("end_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_mfa_credentials_tenant_user_id_key" ON "tenant_mfa_credentials"("tenant_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "licenses_key_hash_key" ON "licenses"("key_hash");

-- CreateIndex
CREATE INDEX "licenses_application_id_idx" ON "licenses"("application_id");

-- CreateIndex
CREATE INDEX "licenses_end_user_id_idx" ON "licenses"("end_user_id");

-- CreateIndex
CREATE INDEX "licenses_key_hash_idx" ON "licenses"("key_hash");

-- CreateIndex
CREATE INDEX "license_activations_license_id_idx" ON "license_activations"("license_id");

-- CreateIndex
CREATE UNIQUE INDEX "license_activations_license_id_machine_fingerprint_key" ON "license_activations"("license_id", "machine_fingerprint");

-- CreateIndex
CREATE INDEX "usage_meters_application_id_idx" ON "usage_meters"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_meters_application_id_slug_key" ON "usage_meters"("application_id", "slug");

-- CreateIndex
CREATE INDEX "usage_records_meter_id_occurred_at_idx" ON "usage_records"("meter_id", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_records_end_user_id_idx" ON "usage_records"("end_user_id");

-- AddForeignKey
ALTER TABLE "oauth_identities" ADD CONSTRAINT "oauth_identities_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_identities" ADD CONSTRAINT "oauth_identities_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_credentials" ADD CONSTRAINT "mfa_credentials_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_mfa_credentials" ADD CONSTRAINT "tenant_mfa_credentials_tenant_user_id_fkey" FOREIGN KEY ("tenant_user_id") REFERENCES "tenant_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_activations" ADD CONSTRAINT "license_activations_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_meters" ADD CONSTRAINT "usage_meters_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "usage_meters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
