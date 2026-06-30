-- CreateEnum
CREATE TYPE "ApplicationRole" AS ENUM ('APP_ADMIN', 'APP_BILLING', 'APP_VIEWER');

-- CreateTable
CREATE TABLE "application_grants" (
    "id" TEXT NOT NULL,
    "tenant_membership_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "role" "ApplicationRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "application_grants_application_id_idx" ON "application_grants"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_grants_tenant_membership_id_application_id_key" ON "application_grants"("tenant_membership_id", "application_id");

-- AddForeignKey
ALTER TABLE "application_grants" ADD CONSTRAINT "application_grants_tenant_membership_id_fkey" FOREIGN KEY ("tenant_membership_id") REFERENCES "tenant_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_grants" ADD CONSTRAINT "application_grants_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
