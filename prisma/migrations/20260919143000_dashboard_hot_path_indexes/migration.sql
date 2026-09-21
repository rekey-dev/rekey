-- Indexes for the per-application overview stats and the super-admin rollups.
--
--   security_events (application_id, type, created_at)
--     The overview tile counts one application's sign-ins and sign-ups over
--     30 days. The (application_id, created_at) index finds the window but
--     then reads every event in it to test `type`.
--   subscriptions (application_id, status)
--     Active-subscription counts per application, on the overview tile and in
--     both super-admin lists. Only (application_id) and (status) existed.
--   end_users (created_at), api_request_logs (created_at),
--   webhook_deliveries (created_at)
--     Deployment-wide "in the last 24h / 7d / 30d" counts on the super-admin
--     overview. Each was a sequential scan of the whole table.
--
-- Plain CREATE INDEX, not CONCURRENTLY: `prisma migrate deploy` sends a
-- migration file as one multi-statement batch, which Postgres runs as a
-- single implicit transaction, and CONCURRENTLY refuses to run inside one.
-- Each build holds a SHARE lock on its table: reads carry on, writes wait
-- until that one index is built. On a large deployment, build them first by
-- hand, without blocking writes (DEPLOY.md, "Upgrading: unreleased"):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "security_events_application_id_type_created_at_idx"
--     ON "security_events" ("application_id", "type", "created_at");
--   ... one per index below, same names ...
--
-- IF NOT EXISTS then makes this migration a no-op for every index already
-- built, so nothing has to be marked applied by hand.

CREATE INDEX IF NOT EXISTS "security_events_application_id_type_created_at_idx"
  ON "security_events" ("application_id", "type", "created_at");

CREATE INDEX IF NOT EXISTS "subscriptions_application_id_status_idx"
  ON "subscriptions" ("application_id", "status");

CREATE INDEX IF NOT EXISTS "end_users_created_at_idx"
  ON "end_users" ("created_at");

CREATE INDEX IF NOT EXISTS "api_request_logs_created_at_idx"
  ON "api_request_logs" ("created_at");

CREATE INDEX IF NOT EXISTS "webhook_deliveries_created_at_idx"
  ON "webhook_deliveries" ("created_at");
