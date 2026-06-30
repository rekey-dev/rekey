-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "application_id" TEXT,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "type" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_events_tenant_id_created_at_idx" ON "security_events"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "security_events_application_id_created_at_idx" ON "security_events"("application_id", "created_at");

-- CreateIndex
CREATE INDEX "security_events_type_idx" ON "security_events"("type");
