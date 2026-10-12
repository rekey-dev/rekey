-- Billing money model 2, expand step 3 of 3: the billing log and its outbox.

-- CreateEnum
CREATE TYPE "BillingEventTier" AS ENUM ('PERMANENT', 'DIAGNOSTIC');

-- CreateEnum
CREATE TYPE "BillingEventActor" AS ENUM ('SYSTEM', 'OPERATOR', 'END_USER', 'PROVIDER');

-- CreateTable
CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "application_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tier" "BillingEventTier" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupe_key" TEXT NOT NULL,
    "actor_type" "BillingEventActor" NOT NULL,
    "actor_id" TEXT,
    "end_user_id" TEXT,
    "subscription_id" TEXT,
    "checkout_session_id" TEXT,
    "payment_id" TEXT,
    "refund_id" TEXT,
    "plan_id" TEXT,
    "plan_price_id" TEXT,
    "coupon_id" TEXT,
    "provider" TEXT,
    "provider_event_id" TEXT,
    "currency" TEXT,
    "amount" INTEGER,
    "data" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_event_outbox" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "billing_event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_events_seq_key" ON "billing_events"("seq");

-- CreateIndex
CREATE INDEX "billing_events_application_id_seq_idx" ON "billing_events"("application_id", "seq");

-- CreateIndex
CREATE INDEX "billing_events_application_id_end_user_id_occurred_at_idx" ON "billing_events"("application_id", "end_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "billing_events_tier_recorded_at_idx" ON "billing_events"("tier", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_events_application_id_type_dedupe_key_key" ON "billing_events"("application_id", "type", "dedupe_key");

-- CreateIndex
CREATE INDEX "billing_event_outbox_processed_at_created_at_idx" ON "billing_event_outbox"("processed_at", "created_at");

-- AddForeignKey
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_event_outbox" ADD CONSTRAINT "billing_event_outbox_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The billing log is append-only: UPDATE, DELETE and TRUNCATE are refused.
-- This stops an application bug or a casual edit from rewriting an event. It
-- is not a defence against a stolen database credential: the role that runs
-- the API owns the table and can drop the trigger. That needs the table to
-- be owned by a separate role.
--
-- What may still change a row:
--   - A transaction that runs SET LOCAL rekey.billing_events_maintenance =
--     'on' (the erasure and retention paths). Any session can set it.
--   - The cascade from deleting an Application or its Tenant. By the time it
--     reaches this table the Application row has gone, which is what the
--     EXISTS test sees.
--   - A TRUNCATE that leaves no Application behind, which is the same thing
--     for every Application at once. One that empties the log and keeps an
--     Application is refused.
--
-- Both functions name the schema of every table they read and pin their
-- search_path, so a temporary table called "applications" cannot stand in
-- for the real one. EXECUTE format() writes the schema this migration runs in
-- into the function text.
DO $do$
BEGIN
  EXECUTE format($sql$
    CREATE FUNCTION "billing_events_refuse_change"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $fn$
    BEGIN
      IF current_setting('rekey.billing_events_maintenance', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE'
         AND NOT EXISTS (SELECT 1 FROM %1$I."applications" AS a WHERE a."id" = OLD."application_id") THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'billing_events is append-only: %% refused', TG_OP
        USING ERRCODE = 'integrity_constraint_violation',
              HINT = 'Only the erasure and retention paths may change the billing log, with SET LOCAL rekey.billing_events_maintenance = ''on''.';
    END;
    $fn$
  $sql$, current_schema());

  EXECUTE format($sql$
    CREATE FUNCTION "billing_events_refuse_truncate"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $fn$
    BEGIN
      IF EXISTS (SELECT 1 FROM %1$I."applications") THEN
        RAISE EXCEPTION 'billing_events is append-only: TRUNCATE refused'
          USING ERRCODE = 'integrity_constraint_violation',
                HINT = 'The billing log is emptied only together with every Application.';
      END IF;
      RETURN NULL;
    END;
    $fn$
  $sql$, current_schema());
END
$do$;

CREATE TRIGGER "billing_events_append_only"
  BEFORE UPDATE OR DELETE ON "billing_events"
  FOR EACH ROW EXECUTE FUNCTION "billing_events_refuse_change"();

-- AFTER, not BEFORE: every table named by the statement and reached by its
-- CASCADE has been emptied by then, so the function can see whether an
-- Application survived. Raising here undoes the whole TRUNCATE.
CREATE TRIGGER "billing_events_no_truncate"
  AFTER TRUNCATE ON "billing_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "billing_events_refuse_truncate"();
