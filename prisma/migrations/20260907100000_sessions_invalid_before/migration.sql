-- Access tokens issued before this instant are refused on their next use.
-- Nullable, no default, no rewrite: every existing row keeps behaving as
-- before until a revocation stamps it.
ALTER TABLE "end_users" ADD COLUMN "sessions_invalid_before" TIMESTAMP(3);
ALTER TABLE "tenant_users" ADD COLUMN "sessions_invalid_before" TIMESTAMP(3);
