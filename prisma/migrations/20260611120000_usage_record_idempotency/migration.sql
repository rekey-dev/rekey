-- AlterTable
ALTER TABLE "usage_records" ADD COLUMN     "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "usage_records_meter_id_idempotency_key_key" ON "usage_records"("meter_id", "idempotency_key");
