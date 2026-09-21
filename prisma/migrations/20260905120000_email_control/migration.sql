-- Email control: a master switch, a per-event switch, and a suppression list.
--
-- Until now `emailService.dispatch` had no gate at all. An Application with a
-- transport configured sent everything it was asked to send, and there was no
-- way to stop it: not globally, not for one event, not for one address. For a
-- product whose own backend already sends transactional mail that means every
-- user gets two of everything, with no lever.
--
-- Three gates, narrowest last, evaluated in that order by `dispatch`:
--
--   1. `applications.emails_enabled = false`  — the whole Application is quiet.
--   2. `email_event_settings.enabled = false` — one event is quiet.
--   3. `email_suppressions`                   — one address is quiet.
--
-- All three are additive and default to today's behaviour, so applying this
-- migration changes nothing until an operator switches something off.
--
-- Cheap on any size of table: one boolean column with a constant default (no
-- rewrite on PG 11+), and two new tables.

-- ---------------------------------------------------------------------------
-- 1. Master switch.
--
-- A column rather than a key in `email_config` because `setCredentials`
-- rewrites that jsonb wholesale — a flag inside it would be silently cleared
-- every time somebody saved transport credentials.
-- ---------------------------------------------------------------------------
ALTER TABLE "applications"
  ADD COLUMN "emails_enabled" BOOLEAN NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- 2. Per-event switch.
--
-- Separate from `email_templates`: a row there is what "customised" means in
-- the panel, and disabling an event must not require rewriting its body first,
-- nor should deleting a customisation re-enable something an operator turned
-- off. A MISSING row means enabled.
-- ---------------------------------------------------------------------------
CREATE TABLE "email_event_settings" (
  "id"             TEXT NOT NULL,
  "application_id" TEXT NOT NULL,
  "event_key"      TEXT NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "updated_at"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "email_event_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_event_settings_application_id_event_key_key"
  ON "email_event_settings" ("application_id", "event_key");

CREATE INDEX "email_event_settings_application_id_idx"
  ON "email_event_settings" ("application_id");

ALTER TABLE "email_event_settings"
  ADD CONSTRAINT "email_event_settings_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "applications" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Suppression list.
--
-- Addresses this Application must not mail, whatever it is trying to send.
-- The address is stored lowercased, matching `email_logs.to_address`, so the
-- unique index is a real uniqueness guarantee rather than a case-sensitive
-- near-miss.
-- ---------------------------------------------------------------------------
CREATE TABLE "email_suppressions" (
  "id"             TEXT NOT NULL,
  "application_id" TEXT NOT NULL,
  "address"        TEXT NOT NULL,
  "reason"         TEXT NOT NULL DEFAULT 'manual',
  "note"           TEXT,
  "created_by"     TEXT,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_suppressions_application_id_address_key"
  ON "email_suppressions" ("application_id", "address");

CREATE INDEX "email_suppressions_application_id_created_at_idx"
  ON "email_suppressions" ("application_id", "created_at");

ALTER TABLE "email_suppressions"
  ADD CONSTRAINT "email_suppressions_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "applications" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
