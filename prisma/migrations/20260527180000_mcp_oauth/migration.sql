-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "client_name" TEXT,
    "redirect_uris" TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_auth_codes" (
    "id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_auth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_auth_codes_code_hash_key" ON "oauth_auth_codes"("code_hash");

-- CreateIndex
CREATE INDEX "oauth_clients_application_id_idx" ON "oauth_clients"("application_id");

-- CreateIndex
CREATE INDEX "oauth_auth_codes_application_id_idx" ON "oauth_auth_codes"("application_id");

-- CreateIndex
CREATE INDEX "oauth_auth_codes_expires_at_idx" ON "oauth_auth_codes"("expires_at");

-- AddForeignKey
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
