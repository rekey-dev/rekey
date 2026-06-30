-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "email_config" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "email_credentials_ciphertext" TEXT;

-- CreateTable
CREATE TABLE "email_templates" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "design_json" JSONB NOT NULL,
    "body_html" TEXT NOT NULL,
    "body_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_templates_application_id_idx" ON "email_templates"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_templates_application_id_event_key_key" ON "email_templates"("application_id", "event_key");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_application_id_idx" ON "email_verification_tokens"("application_id");

-- CreateIndex
CREATE INDEX "email_verification_tokens_end_user_id_idx" ON "email_verification_tokens"("end_user_id");

-- CreateIndex
CREATE INDEX "email_verification_tokens_expires_at_idx" ON "email_verification_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
