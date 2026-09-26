-- Operator refresh tokens remember the workspace their session is in, so a
-- refresh no longer moves an operator back to their oldest workspace.
-- Nullable, no backfill: a null row refreshes into the oldest membership,
-- which is what every existing row did.
ALTER TABLE "tenant_refresh_tokens" ADD COLUMN "active_tenant_id" TEXT;
CREATE INDEX "tenant_refresh_tokens_active_tenant_id_idx" ON "tenant_refresh_tokens"("active_tenant_id");
ALTER TABLE "tenant_refresh_tokens" ADD CONSTRAINT "tenant_refresh_tokens_active_tenant_id_fkey" FOREIGN KEY ("active_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
