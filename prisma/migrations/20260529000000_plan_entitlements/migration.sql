-- CreateEnum
CREATE TYPE "PlanEntitlementKind" AS ENUM ('FEATURE', 'CREDIT', 'LICENSE', 'USAGE');

-- CreateEnum
CREATE TYPE "EntitlementValueType" AS ENUM ('BOOL', 'INT', 'STRING');

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN "entitlement_overrides" JSONB;

-- CreateTable
CREATE TABLE "plan_entitlements" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "kind" "PlanEntitlementKind" NOT NULL,
    "key" TEXT NOT NULL DEFAULT '',
    "value_type" "EntitlementValueType",
    "value" TEXT,
    "quantity" INTEGER,
    "license_kind" "LicenseKind",
    "rollover" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_entitlements_plan_id_idx" ON "plan_entitlements"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_entitlements_plan_id_kind_key_key" ON "plan_entitlements"("plan_id", "kind", "key");

-- AddForeignKey
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
