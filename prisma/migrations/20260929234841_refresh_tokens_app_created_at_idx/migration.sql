-- The analytics rollup counts, per Application and local day, the users with
-- a session issued or refreshed inside the day's window: one range scan here
-- instead of a probe per user.
--
-- CONCURRENTLY, so sign-ins and refreshes keep writing while it builds. It
-- cannot run inside a transaction block, which is why this migration holds
-- this one statement and nothing else.
--
-- If a build is interrupted, Postgres leaves an INVALID index under this name
-- and IF NOT EXISTS would then skip it. Recover with
--   DROP INDEX CONCURRENTLY IF EXISTS "refresh_tokens_application_id_created_at_idx";
-- and run this statement again (or `prisma migrate resolve --rolled-back` this
-- migration and deploy again). docs/analytics.md, "Daily rollup", has the steps.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "refresh_tokens_application_id_created_at_idx"
  ON "refresh_tokens" ("application_id", "created_at");
