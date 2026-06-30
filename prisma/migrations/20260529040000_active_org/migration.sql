-- RefreshToken: per-session active organization (the `oid` access-token claim)
ALTER TABLE "refresh_tokens" ADD COLUMN "active_organization_id" TEXT;
CREATE INDEX "refresh_tokens_active_organization_id_idx" ON "refresh_tokens"("active_organization_id");
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_active_organization_id_fkey" FOREIGN KEY ("active_organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
