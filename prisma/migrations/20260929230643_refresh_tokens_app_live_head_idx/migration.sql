-- Live session heads per Application, for the analytics rollup's OS, browser
-- and app-version counts. Every refresh adds a row, so without this the job
-- would read every rotation row an Application has. The INCLUDE columns let
-- the count run as an index-only scan.
--
-- Prisma 6 cannot describe a partial index, so it lives only here;
-- schema.prisma documents it on RefreshToken.
--
-- CONCURRENTLY, so sign-ins and refreshes keep writing while it builds. It
-- cannot run inside a transaction block, which is why this migration holds
-- this one statement and nothing else: Prisma sends a migration file as one
-- script, and Postgres only runs a single-statement script outside an
-- implicit transaction.
--
-- If a build is interrupted, Postgres leaves an INVALID index under this name
-- and IF NOT EXISTS would then skip it. Recover with
--   DROP INDEX CONCURRENTLY IF EXISTS "refresh_tokens_app_live_head_idx";
-- and run this statement again (or `prisma migrate resolve --rolled-back` this
-- migration and deploy again). docs/analytics.md, "Daily rollup", has the steps.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "refresh_tokens_app_live_head_idx"
  ON "refresh_tokens" ("application_id")
  INCLUDE ("expires_at", "client_platform", "client_os", "client_browser", "client_app_version")
  WHERE "replaced_by_id" IS NULL AND "revoked_at" IS NULL;
