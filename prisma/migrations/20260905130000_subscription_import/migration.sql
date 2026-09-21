-- Subscription import: reading what a billing system already sold.
--
-- An import is a RUN, not a call. The operator presses a button and gets a
-- preview — every row the provider returned, what would happen to it, and why —
-- and then applies it, or does not. A one-shot "import now" would be an
-- irreversible bulk write against somebody else's data, decided from a button
-- with no way to look first.
--
-- Two tables, no changes to anything existing, so this is additive and cheap.
-- Items are kept after an apply on purpose: "why does this customer have this
-- subscription" is answered by the run that created it, and an import that
-- deletes its own working is one nobody can audit.

CREATE TABLE "subscription_import_runs" (
  "id"              TEXT NOT NULL,
  "application_id"  TEXT NOT NULL,
  "provider"        TEXT NOT NULL,
  -- dry_run | applied
  "mode"            TEXT NOT NULL DEFAULT 'dry_run',
  -- queued | running | ready | applying | applied | failed
  "status"          TEXT NOT NULL DEFAULT 'queued',
  -- email | email_or_create
  "match_strategy"  TEXT NOT NULL,
  "started_by"      TEXT NOT NULL,
  "counts"          JSONB NOT NULL DEFAULT '{}',
  "error"           TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at"    TIMESTAMP(3),

  CONSTRAINT "subscription_import_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "subscription_import_runs_application_id_created_at_idx"
  ON "subscription_import_runs" ("application_id", "created_at");

ALTER TABLE "subscription_import_runs"
  ADD CONSTRAINT "subscription_import_runs_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "applications" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "subscription_import_items" (
  "id"              TEXT NOT NULL,
  "run_id"          TEXT NOT NULL,
  -- The provider's own subscription id. The idempotency key for the whole
  -- feature: re-importing the same id never creates a second subscription.
  "external_id"     TEXT NOT NULL,
  "email"           TEXT,
  "plan_ref"        TEXT,
  -- match | create | skip_no_plan | skip_active | skip_invalid | error
  "outcome"         TEXT NOT NULL,
  "end_user_id"     TEXT,
  "plan_slug"       TEXT,
  "subscription_id" TEXT,
  "detail"          JSONB NOT NULL DEFAULT '{}',

  CONSTRAINT "subscription_import_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "subscription_import_items_run_id_outcome_idx"
  ON "subscription_import_items" ("run_id", "outcome");

ALTER TABLE "subscription_import_items"
  ADD CONSTRAINT "subscription_import_items_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "subscription_import_runs" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
