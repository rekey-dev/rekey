-- CreateTable
CREATE TABLE "free_tier_claims" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "subscription_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "free_tier_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "free_tier_claims_application_id_end_user_id_plan_id_key" ON "free_tier_claims"("application_id", "end_user_id", "plan_id");

-- AddForeignKey
ALTER TABLE "free_tier_claims" ADD CONSTRAINT "free_tier_claims_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_tier_claims" ADD CONSTRAINT "free_tier_claims_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_tier_claims" ADD CONSTRAINT "free_tier_claims_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: every existing self-serve free-tier activation is a claim already
-- spent, on the beneficiary its row names now. Without this, a user who
-- activated before this migration could still claim again for a new
-- organization. `grant.note` is written only by `activateFreePlan`.
INSERT INTO "free_tier_claims" ("id", "application_id", "end_user_id", "plan_id", "organization_id", "subscription_id", "created_at")
SELECT gen_random_uuid()::text, s."application_id", s."end_user_id", s."plan_id", s."beneficiary_org_id", s."id", CURRENT_TIMESTAMP
FROM "subscriptions" s
WHERE s."metadata" -> 'grant' ->> 'note' = 'self-serve free tier'
ON CONFLICT ("application_id", "end_user_id", "plan_id") DO NOTHING;
