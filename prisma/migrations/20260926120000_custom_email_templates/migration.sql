-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "email_recipients_must_be_end_users" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "email_logs" ADD COLUMN     "custom_template_key" TEXT,
ADD COLUMN     "custom_template_version" INTEGER,
ADD COLUMN     "idempotency_fingerprint" TEXT,
ADD COLUMN     "idempotency_key" TEXT;

-- CreateTable
CREATE TABLE "custom_email_templates" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "from_name" TEXT,
    "subject" TEXT NOT NULL,
    "design_json" JSONB,
    "body_html" TEXT NOT NULL,
    "body_text" TEXT,
    "variable_schema" JSONB NOT NULL,
    "link_domains" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_email_template_versions" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "from_name" TEXT,
    "subject" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "body_text" TEXT,
    "variable_schema" JSONB NOT NULL,
    "link_domains" TEXT[],
    "sender_domain" TEXT NOT NULL,
    "published_by" TEXT,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_email_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custom_email_templates_application_id_key_key" ON "custom_email_templates"("application_id", "key");

-- CreateIndex
CREATE INDEX "custom_email_template_versions_application_id_idx" ON "custom_email_template_versions"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_email_template_versions_template_id_version_key" ON "custom_email_template_versions"("template_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "email_logs_application_id_idempotency_key_key" ON "email_logs"("application_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "custom_email_templates" ADD CONSTRAINT "custom_email_templates_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_email_template_versions" ADD CONSTRAINT "custom_email_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "custom_email_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_email_template_versions" ADD CONSTRAINT "custom_email_template_versions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

