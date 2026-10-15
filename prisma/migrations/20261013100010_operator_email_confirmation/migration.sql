-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "created_by_tenant_user_id" TEXT;

-- AlterTable
ALTER TABLE "webhook_endpoints" ADD COLUMN     "created_by_tenant_user_id" TEXT;

-- CreateTable
CREATE TABLE "tenant_email_verification_tokens" (
    "id" TEXT NOT NULL,
    "tenant_user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_email_verification_tokens_token_hash_key" ON "tenant_email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "tenant_email_verification_tokens_tenant_user_id_idx" ON "tenant_email_verification_tokens"("tenant_user_id");

-- CreateIndex
CREATE INDEX "api_keys_created_by_tenant_user_id_idx" ON "api_keys"("created_by_tenant_user_id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_created_by_tenant_user_id_idx" ON "webhook_endpoints"("created_by_tenant_user_id");

-- AddForeignKey
ALTER TABLE "tenant_email_verification_tokens" ADD CONSTRAINT "tenant_email_verification_tokens_tenant_user_id_fkey" FOREIGN KEY ("tenant_user_id") REFERENCES "tenant_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

