-- CreateTable
CREATE TABLE "contact_lists" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'generic',
    "field_schema" JSONB NOT NULL DEFAULT '[]',
    "lawful_basis" TEXT NOT NULL DEFAULT 'consent',
    "consent_text" TEXT,
    "consent_version" INTEGER NOT NULL DEFAULT 0,
    "public_capture" BOOLEAN NOT NULL DEFAULT false,
    "block_disposable" BOOLEAN NOT NULL DEFAULT true,
    "submission_retention_days" INTEGER,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_list_consent_versions" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_list_consent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_list_members" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "consent_version" INTEGER,
    "consent_at" TIMESTAMP(3),
    "consent_ip_prefix" TEXT,
    "source_url" TEXT,
    "unsubscribed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_list_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_submissions" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_lists_application_id_created_at_idx" ON "contact_lists"("application_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "contact_lists_application_id_key_key" ON "contact_lists"("application_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "contact_list_consent_versions_list_id_version_key" ON "contact_list_consent_versions"("list_id", "version");

-- CreateIndex
CREATE INDEX "contacts_application_id_created_at_idx" ON "contacts"("application_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_application_id_email_key" ON "contacts"("application_id", "email");

-- CreateIndex
CREATE INDEX "contact_list_members_app_list_status_idx" ON "contact_list_members"("application_id", "list_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "contact_list_members_list_id_updated_at_id_idx" ON "contact_list_members"("list_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "contact_list_members_contact_id_idx" ON "contact_list_members"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_list_members_list_id_contact_id_key" ON "contact_list_members"("list_id", "contact_id");

-- CreateIndex
CREATE INDEX "contact_submissions_list_id_created_at_idx" ON "contact_submissions"("list_id", "created_at");

-- CreateIndex
CREATE INDEX "contact_submissions_contact_id_idx" ON "contact_submissions"("contact_id");

-- CreateIndex
CREATE INDEX "contact_submissions_created_at_idx" ON "contact_submissions"("created_at");

-- AddForeignKey
ALTER TABLE "contact_lists" ADD CONSTRAINT "contact_lists_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_list_consent_versions" ADD CONSTRAINT "contact_list_consent_versions_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "contact_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_list_members" ADD CONSTRAINT "contact_list_members_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "contact_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_list_members" ADD CONSTRAINT "contact_list_members_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_submissions" ADD CONSTRAINT "contact_submissions_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "contact_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_submissions" ADD CONSTRAINT "contact_submissions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
