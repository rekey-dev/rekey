-- DropIndex
DROP INDEX IF EXISTS "api_keys_key_hash_idx";

-- DropIndex
DROP INDEX IF EXISTS "licenses_key_hash_idx";

-- DropIndex
DROP INDEX IF EXISTS "tenant_api_tokens_token_hash_idx";

-- CreateIndex
CREATE INDEX "payments_subscription_id_idx" ON "payments"("subscription_id");

-- CreateIndex
CREATE INDEX "usage_records_meter_id_end_user_id_occurred_at_idx" ON "usage_records"("meter_id", "end_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_records_meter_id_organization_id_occurred_at_idx" ON "usage_records"("meter_id", "organization_id", "occurred_at");
