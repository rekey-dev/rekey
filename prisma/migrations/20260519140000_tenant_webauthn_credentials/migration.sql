-- CreateTable
CREATE TABLE "tenant_webauthn_credentials" (
    "id" TEXT NOT NULL,
    "tenant_user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "device_name" TEXT,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_webauthn_credentials_credential_id_key" ON "tenant_webauthn_credentials"("credential_id");

-- CreateIndex
CREATE INDEX "tenant_webauthn_credentials_tenant_user_id_idx" ON "tenant_webauthn_credentials"("tenant_user_id");

-- AddForeignKey
ALTER TABLE "tenant_webauthn_credentials" ADD CONSTRAINT "tenant_webauthn_credentials_tenant_user_id_fkey" FOREIGN KEY ("tenant_user_id") REFERENCES "tenant_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
