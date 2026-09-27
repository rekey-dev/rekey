-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "mode" TEXT;

-- CreateIndex
CREATE INDEX "webhook_events_application_id_provider_mode_received_at_idx" ON "webhook_events"("application_id", "provider", "mode", "received_at");
