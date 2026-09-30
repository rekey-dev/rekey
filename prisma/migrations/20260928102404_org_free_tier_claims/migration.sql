-- CreateTable
CREATE TABLE "organization_free_tier_claims" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "claimed_by_end_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_free_tier_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_free_tier_claims_org_idx" ON "organization_free_tier_claims"("organization_id");

-- CreateIndex
CREATE INDEX "org_free_tier_claims_plan_idx" ON "organization_free_tier_claims"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_free_tier_claims_app_org_plan_key" ON "organization_free_tier_claims"("application_id", "organization_id", "plan_id");

-- AddForeignKey
ALTER TABLE "organization_free_tier_claims" ADD CONSTRAINT "organization_free_tier_claims_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_free_tier_claims" ADD CONSTRAINT "organization_free_tier_claims_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_free_tier_claims" ADD CONSTRAINT "organization_free_tier_claims_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
