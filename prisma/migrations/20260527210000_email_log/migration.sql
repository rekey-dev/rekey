-- CreateTable
CREATE TABLE "email_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "application_id" TEXT,
    "to_address" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "event_key" TEXT,
    "via" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_logs_application_id_created_at_idx" ON "email_logs"("application_id", "created_at");

-- CreateIndex
CREATE INDEX "email_logs_tenant_id_created_at_idx" ON "email_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "email_logs_status_idx" ON "email_logs"("status");

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
