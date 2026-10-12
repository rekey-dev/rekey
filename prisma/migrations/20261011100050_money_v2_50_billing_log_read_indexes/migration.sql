-- Billing money model 2, step C: indexes for the billing log readers.
-- Each serves one filter of the operator log, paged on seq inside one
-- Application: by end user, subscription, payment, type, and time range.

-- CreateIndex
CREATE INDEX "billing_events_application_id_end_user_id_seq_idx" ON "billing_events"("application_id", "end_user_id", "seq");

-- CreateIndex
CREATE INDEX "billing_events_application_id_subscription_id_seq_idx" ON "billing_events"("application_id", "subscription_id", "seq");

-- CreateIndex
CREATE INDEX "billing_events_application_id_payment_id_seq_idx" ON "billing_events"("application_id", "payment_id", "seq");

-- CreateIndex
CREATE INDEX "billing_events_application_id_type_seq_idx" ON "billing_events"("application_id", "type", "seq");

-- CreateIndex
CREATE INDEX "billing_events_application_id_occurred_at_idx" ON "billing_events"("application_id", "occurred_at");

