-- Operator passwordless sign-in (magic link) tokens. Single-use, 15-min, hash-only.
CREATE TABLE "tenant_magic_link_tokens" (
    "id" TEXT NOT NULL,
    "tenant_user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tenant_magic_link_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_magic_link_tokens_token_hash_key" ON "tenant_magic_link_tokens"("token_hash");
CREATE INDEX "tenant_magic_link_tokens_tenant_user_id_idx" ON "tenant_magic_link_tokens"("tenant_user_id");
ALTER TABLE "tenant_magic_link_tokens" ADD CONSTRAINT "tenant_magic_link_tokens_tenant_user_id_fkey" FOREIGN KEY ("tenant_user_id") REFERENCES "tenant_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
