-- Lookup index for end-user erasure (end-user-erasure.service.ts).
--
-- Erasure tombstones every email_logs row sent to the erased person's address,
-- inside the erasure transaction. The only index led by application_id was
-- (application_id, created_at), so that update scanned the Application's whole
-- send history while the transaction held its locks.

CREATE INDEX "email_logs_application_id_to_address_idx" ON "email_logs"("application_id", "to_address");
