-- Operator personal-access-tokens (PATs). Long-lived, revocable, SCOPED.
-- Hash-only at rest; raw `rp_op_…` shown once at mint. Bound to one operator
-- AND one workspace. Default-deny scopes (writes need explicit scope).
CREATE TABLE "tenant_api_tokens" (
    "id" TEXT NOT NULL,
    "tenant_user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tenant_api_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_api_tokens_token_hash_key" ON "tenant_api_tokens"("token_hash");
CREATE INDEX "tenant_api_tokens_tenant_user_id_idx" ON "tenant_api_tokens"("tenant_user_id");
CREATE INDEX "tenant_api_tokens_tenant_id_idx" ON "tenant_api_tokens"("tenant_id");
CREATE INDEX "tenant_api_tokens_token_hash_idx" ON "tenant_api_tokens"("token_hash");
ALTER TABLE "tenant_api_tokens" ADD CONSTRAINT "tenant_api_tokens_tenant_user_id_fkey" FOREIGN KEY ("tenant_user_id") REFERENCES "tenant_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_api_tokens" ADD CONSTRAINT "tenant_api_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
