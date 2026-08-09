-- Trials: a plan can offer one, a subscription can be in one.
--
-- TRIALING is added to the status enum in the same migration that adds the
-- columns, because the two ship together: `mapStripeSubStatus` starts
-- returning TRIALING for Stripe's `trialing`, and entitlement resolution
-- starts honouring it, in one change. Splitting them would either emit a
-- status nothing entitles (locking out every existing dashboard-configured
-- trial) or entitle a status nothing emits.
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'TRIALING' AFTER 'ACTIVE';

ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "trial_days" INTEGER;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "trial_ends_at" TIMESTAMP(3);
