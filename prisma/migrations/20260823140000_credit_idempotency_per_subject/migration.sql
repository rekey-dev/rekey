-- Scope credit idempotency to the billing SUBJECT.
--
-- `(application_id, idempotency_key)` treated a client-supplied key as globally
-- unique within the application. But such a key names what is being paid FOR,
-- not who is paying — the schema's own example is a lead id — so two end users
-- drawing down for the same lead sent the same key. The second found the
-- first's row, was told `applied: false`, consumed for free, and was handed
-- another subject's `balance_after`.
--
-- Widening a unique tuple can only ever be satisfied by data that already
-- satisfied the narrower one, so this cannot fail on existing rows: if
-- (application_id, idempotency_key) held, (application_id, subject_key,
-- idempotency_key) holds too.
--
-- NULL idempotency keys still repeat freely, which is deliberate — they are
-- manual operator adjustments — because a NULL never conflicts in a Postgres
-- unique index.

-- DropIndex: redundant once the unique below covers it as a prefix.
DROP INDEX "credit_ledger_application_id_subject_key_idx";

-- DropIndex
DROP INDEX "credit_ledger_application_id_idempotency_key_key";

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_application_id_subject_key_idempotency_key_key" ON "credit_ledger"("application_id", "subject_key", "idempotency_key");
