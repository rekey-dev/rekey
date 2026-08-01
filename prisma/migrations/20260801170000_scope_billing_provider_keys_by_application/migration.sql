-- Scope the three inbound-billing provider keys by application_id.
--
-- All three were global, which silently assumed one provider account per
-- deployment. Two Applications wired to the same Stripe/PayPal/Razorpay
-- account — staging + production, or a cloned app — see the SAME `evt_...` /
-- charge / subscription id, and the consequences were the worst kind:
--
--   * webhook_events UNIQUE(provider, provider_event_id): tenant B's genuine
--     `invoice.paid` collided with tenant A's already-processed row, the
--     pipeline read `processedAt` and replied 200 {processed:false,
--     reason:"duplicate"}, and the provider stopped retrying. The event was
--     lost permanently and silently.
--   * payments UNIQUE(provider_payment_id): the applier's P2002 recovery path
--     does `payment.findUnique({ provider_payment_id })` and would hand tenant
--     A's payment id back into tenant B's event stream.
--   * subscriptions UNIQUE(provider_sub_id): the second tenant's activation
--     `updateMany` threw P2002, the pipeline answered 5xx, and the provider
--     retried an activation that could never succeed.
--
-- These ids are only ever unique WITHIN the provider account they came from,
-- and the Application is what owns that account's credentials. Every read of
-- all three already filters by application_id.
--
-- Data safety: the new keys are strictly WEAKER than the ones they replace
-- (any set of rows unique on (provider, event_id) is trivially unique on
-- (application_id, provider, event_id)), so no existing row can violate them
-- and this migration cannot fail on data. NULL provider_payment_id /
-- provider_sub_id stay distinct under Postgres NULL semantics exactly as
-- before.
--
-- Ordering: create the new index BEFORE dropping the old one, so there is
-- never an instant in which no idempotency guard is enforced. Not
-- CONCURRENTLY — `prisma migrate deploy` runs each migration file inside one
-- transaction and CREATE INDEX CONCURRENTLY cannot run there. These tables
-- take a brief write-blocking lock during the build; on a table large enough
-- for that to matter, build the three indexes by hand with CONCURRENTLY first
-- and mark this migration `prisma migrate resolve --applied`.

CREATE UNIQUE INDEX "webhook_events_application_id_provider_provider_event_id_key"
  ON "webhook_events"("application_id", "provider", "provider_event_id");

DROP INDEX "webhook_events_provider_provider_event_id_key";

CREATE UNIQUE INDEX "payments_application_id_provider_payment_id_key"
  ON "payments"("application_id", "provider_payment_id");

DROP INDEX "payments_provider_payment_id_key";

CREATE UNIQUE INDEX "subscriptions_application_id_provider_sub_id_key"
  ON "subscriptions"("application_id", "provider_sub_id");

DROP INDEX "subscriptions_provider_sub_id_key";
