-- CreateEnum
CREATE TYPE "DunningCaseStatus" AS ENUM ('OPEN', 'RECOVERED', 'EXHAUSTED', 'CANCELED');

-- CreateTable
CREATE TABLE "dunning_cases" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "end_user_id" TEXT,
    "organization_id" TEXT,
    "status" "DunningCaseStatus" NOT NULL DEFAULT 'OPEN',
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_failure_at" TIMESTAMP(3),
    "next_action_at" TIMESTAMP(3),
    "reminders_sent" INTEGER NOT NULL DEFAULT 0,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dunning_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dunning_cases_application_id_status_idx" ON "dunning_cases"("application_id", "status");

-- CreateIndex
CREATE INDEX "dunning_cases_status_next_action_at_idx" ON "dunning_cases"("status", "next_action_at");

-- CreateIndex
CREATE INDEX "dunning_cases_subscription_id_status_idx" ON "dunning_cases"("subscription_id", "status");

-- AddForeignKey
ALTER TABLE "dunning_cases" ADD CONSTRAINT "dunning_cases_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dunning_cases" ADD CONSTRAINT "dunning_cases_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
