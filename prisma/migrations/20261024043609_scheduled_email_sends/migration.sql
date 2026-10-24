-- AlterTable
ALTER TABLE "email_logs" ADD COLUMN     "scheduled_request" JSONB,
ADD COLUMN     "send_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "email_logs_status_send_at_idx" ON "email_logs"("status", "send_at");
