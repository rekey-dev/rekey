-- DropIndex
DROP INDEX "billing_event_outbox_processed_at_created_at_idx";

-- AlterTable
ALTER TABLE "billing_event_outbox" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "payload" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "billing_event_outbox_processed_at_next_attempt_at_created_a_idx" ON "billing_event_outbox"("processed_at", "next_attempt_at", "created_at");

