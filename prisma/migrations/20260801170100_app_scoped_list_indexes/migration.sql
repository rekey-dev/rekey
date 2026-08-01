-- (application_id, created_at) indexes for the app-scoped, newest-first
-- operator lists.
--
-- Every one of these tables already had a plain `(application_id)` index, so
-- the planner could find the app's rows but then had to read ALL of them and
-- sort to answer `ORDER BY created_at DESC LIMIT 25`. Measured on end_users
-- with 40k rows in one application beside 5k in another, Postgres 16, warm:
--
--   before: Sort (top-N heapsort) → Seq Scan on end_users
--             9.809 ms, 590 shared buffers
--   after:  Incremental Sort → Index Scan Backward using
--           end_users_application_id_created_at_idx
--             0.043 ms, 4 shared buffers
--
-- end_users is the one that was measured and the one that grows fastest;
-- payments/subscriptions/licenses/organizations are the same query shape on
-- tables that grow with the same end-user count, so they get the same
-- treatment rather than waiting to be found one at a time.
--
-- Deliberately NOT added: coupons, plans, api_keys, usage_meters,
-- webhook_endpoints. Those are operator-authored configuration, bounded at
-- tens of rows per application, where a sort costs nothing and an extra index
-- costs write throughput.
--
-- Not CONCURRENTLY — see the note in 20260801170000; `prisma migrate deploy`
-- wraps each migration in a transaction.

CREATE INDEX "end_users_application_id_created_at_idx"
  ON "end_users"("application_id", "created_at");

CREATE INDEX "payments_application_id_created_at_idx"
  ON "payments"("application_id", "created_at");

CREATE INDEX "subscriptions_application_id_created_at_idx"
  ON "subscriptions"("application_id", "created_at");

CREATE INDEX "licenses_application_id_created_at_idx"
  ON "licenses"("application_id", "created_at");

CREATE INDEX "organizations_application_id_created_at_idx"
  ON "organizations"("application_id", "created_at");
