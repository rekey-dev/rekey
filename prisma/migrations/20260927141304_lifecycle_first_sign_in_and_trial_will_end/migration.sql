-- AlterTable
ALTER TABLE "end_users" ADD COLUMN     "first_signed_in_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "trial_will_end_notified_for" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "subscriptions_status_trial_ends_at_idx" ON "subscriptions"("status", "trial_ends_at");

-- Backfill: every existing account counts as already signed in. Refresh tokens
-- and sign-in events are pruned, so which older accounts really never signed in
-- cannot be told, and a false `firstSignIn: true` on a long-standing user is
-- worse than a missing one on a pending invitee.
UPDATE "end_users" SET "first_signed_in_at" = "created_at" WHERE "first_signed_in_at" IS NULL;
