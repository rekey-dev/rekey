-- CreateTable
CREATE TABLE "impersonation_audits" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operator_user_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "reason" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "user_agent" TEXT,
    "ip" TEXT,

    CONSTRAINT "impersonation_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "impersonation_audits_application_id_idx" ON "impersonation_audits"("application_id");

-- CreateIndex
CREATE INDEX "impersonation_audits_operator_user_id_idx" ON "impersonation_audits"("operator_user_id");

-- CreateIndex
CREATE INDEX "impersonation_audits_end_user_id_idx" ON "impersonation_audits"("end_user_id");

-- CreateIndex
CREATE INDEX "impersonation_audits_started_at_idx" ON "impersonation_audits"("started_at");

