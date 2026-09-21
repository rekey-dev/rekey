-- Range-scan indexes for the log retention sweep (apps/api/src/lib/log-retention.ts).
--
-- The sweep selects the oldest rows past LOG_RETENTION_DAYS every ten minutes.
-- Without an index led by the age column that is a sequential scan of the
-- whole table on every tick, on exactly the tables that are large enough to
-- need pruning. Each index costs one extra write per insert; that is the price
-- of a table that stops growing.

CREATE INDEX "security_events_created_at_idx" ON "security_events"("created_at");

CREATE INDEX "email_logs_created_at_idx" ON "email_logs"("created_at");

-- Deliveries age by updated_at, not created_at: a FAILED delivery an operator
-- redelivered yesterday is not stale because it was first created last month.
-- Status leads because the sweep only ever reads SUCCEEDED and FAILED; PENDING
-- is live retry state and is never pruned.
CREATE INDEX "webhook_deliveries_status_updated_at_idx" ON "webhook_deliveries"("status", "updated_at");
