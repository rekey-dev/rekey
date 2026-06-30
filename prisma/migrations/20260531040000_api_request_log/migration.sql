-- CreateTable
CREATE TABLE "api_request_logs" (
    "id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "route_path" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "application_id" TEXT,
    "tenant_id" TEXT,
    "operator_user_id" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_request_logs_application_id_created_at_idx" ON "api_request_logs"("application_id", "created_at");

-- CreateIndex
CREATE INDEX "api_request_logs_tenant_id_created_at_idx" ON "api_request_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "api_request_logs_operator_user_id_created_at_idx" ON "api_request_logs"("operator_user_id", "created_at");

