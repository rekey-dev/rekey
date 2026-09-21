-- The session (refresh-token family) a row belongs to, carried in the access
-- token's `sid` claim so a single-session revoke ends that session's access
-- token without the per-user stamp. Existing rows become their own session;
-- rotations from here on copy the value forward.
ALTER TABLE "refresh_tokens" ADD COLUMN "session_id" TEXT;
UPDATE "refresh_tokens" SET "session_id" = "id";
ALTER TABLE "refresh_tokens" ALTER COLUMN "session_id" SET NOT NULL;
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

ALTER TABLE "tenant_refresh_tokens" ADD COLUMN "session_id" TEXT;
UPDATE "tenant_refresh_tokens" SET "session_id" = "id";
ALTER TABLE "tenant_refresh_tokens" ALTER COLUMN "session_id" SET NOT NULL;
CREATE INDEX "tenant_refresh_tokens_session_id_idx" ON "tenant_refresh_tokens"("session_id");
