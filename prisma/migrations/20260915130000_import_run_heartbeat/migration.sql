-- An apply runs inside one HTTP request, so a restart mid-apply left the run
-- `applying` with nothing to move it on. The heartbeat lets a later apply tell
-- a live run from an abandoned one, and the lease lets it take the run over.
-- Existing rows keep NULL, which reads as stale: a run already stuck before
-- this migration is recoverable too.
ALTER TABLE "subscription_import_runs" ADD COLUMN "heartbeat_at" TIMESTAMP(3);
ALTER TABLE "subscription_import_runs" ADD COLUMN "apply_lease" TEXT;
