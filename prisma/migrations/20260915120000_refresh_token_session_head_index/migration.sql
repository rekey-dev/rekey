-- Index the session head lookup the session middleware runs on every
-- authenticated request: the live row of a `sid` family.
--
-- Rotated rows are kept for the refresh lifetime, so a long-lived session
-- piles up thousands of rows under one session_id. With only the plain
-- session_id index the planner estimated hundreds of matches, and with
-- LIMIT 1 chose a sequential scan (about 20 ms on a 206k row table). A
-- UNIQUE index tells it there is at most one row, so the plan stays an index
-- scan whatever the statistics say.
--
-- The predicate excludes revoked rows as well as rotated ones, and that is
-- what makes UNIQUE safe. Rotation (lib/refresh-tokens.ts and
-- lib/tenant-refresh-tokens.ts) revokes the presented row, inserts the
-- replacement, then sets replaced_by_id on the old row, all in one
-- transaction. Unique indexes are checked per statement, so a predicate on
-- replaced_by_id alone would reject that insert. Revoking first takes the old
-- row out of this index before the new one arrives. Nothing ever inserts a
-- live row into a session that already has one, and rows from before the
-- session_id column were backfilled with their own id.
--
-- The lookups filter `revoked_at IS NULL` to match. That is the same answer:
-- a missing head and a revoked head both mean the session has ended.
--
-- Prisma 6 cannot describe a partial index, and `prisma migrate diff` ignores
-- one, so these live only here. schema.prisma documents them on each model.
--
-- Plain CREATE INDEX, not CONCURRENTLY: migrations run in a transaction. Each
-- build holds a SHARE lock on its table, blocking sign-in and refresh (inserts
-- and updates) until it finishes. Reads are not blocked.
CREATE UNIQUE INDEX "refresh_tokens_session_live_head_key"
  ON "refresh_tokens" ("session_id")
  WHERE "replaced_by_id" IS NULL AND "revoked_at" IS NULL;

CREATE UNIQUE INDEX "tenant_refresh_tokens_session_live_head_key"
  ON "tenant_refresh_tokens" ("session_id")
  WHERE "replaced_by_id" IS NULL AND "revoked_at" IS NULL;

-- The head lookup was the only reader of the plain session_id indexes.
DROP INDEX "refresh_tokens_session_id_idx";
DROP INDEX "tenant_refresh_tokens_session_id_idx";
