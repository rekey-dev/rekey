-- CreateEnum
CREATE TYPE "TrialRedemptionStatus" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED');

-- CreateTable
CREATE TABLE "trial_redemptions" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "plan_id" TEXT NOT NULL,
    "status" "TrialRedemptionStatus" NOT NULL DEFAULT 'RESERVED',
    "checkout_session_id" TEXT,
    "subscription_id" TEXT,
    "trial_days" INTEGER,
    "expires_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trial_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trial_redemptions_application_id_subject_key_status_idx" ON "trial_redemptions"("application_id", "subject_key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "trial_redemptions_application_id_checkout_session_id_key" ON "trial_redemptions"("application_id", "checkout_session_id");

-- AddForeignKey
ALTER TABLE "trial_redemptions" ADD CONSTRAINT "trial_redemptions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_redemptions" ADD CONSTRAINT "trial_redemptions_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_redemptions" ADD CONSTRAINT "trial_redemptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
