-- Indexes on refresh_tokens.created_at + tenant_refresh_tokens.created_at.
--
-- The super-admin retention dashboard (apps/admin → /api/v1/admin/metrics/retention)
-- counts distinct end-users with a refresh-token created inside a 24h/7d/30d
-- window via `groupBy endUserId where createdAt >= since`. Without these
-- indexes the query is a sequential scan over the full token history, which
-- grows with sign-in volume (every sign-in and rotation writes a row).
--
-- CONCURRENTLY: building the index without locking the table out from writes,
-- so a live deployment can run the migration without an auth outage. Single
-- transaction-per-statement.

CREATE INDEX IF NOT EXISTS "refresh_tokens_created_at_idx"
  ON "refresh_tokens" ("created_at");

CREATE INDEX IF NOT EXISTS "tenant_refresh_tokens_created_at_idx"
  ON "tenant_refresh_tokens" ("created_at");
