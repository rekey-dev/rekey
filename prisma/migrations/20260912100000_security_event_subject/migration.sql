-- The end-user a security event is ABOUT, whoever performed it. Set by
-- `recordSecurityEvent` from `metadata.endUserId`, falling back to the actor
-- when the actor is an end-user. Replaces a panel read that pulled three
-- 200-row pages of the whole application's events and matched in memory.
ALTER TABLE "security_events" ADD COLUMN "subject_end_user_id" TEXT;

-- Backfill with the same rule the write path uses, so existing history is
-- reachable through the filter and not only events written from now on.
-- One pass over the table; security_events has no pruning, so on a large
-- deployment run this in a maintenance window.
UPDATE "security_events"
   SET "subject_end_user_id" = COALESCE(
         NULLIF("metadata"->>'endUserId', ''),
         CASE WHEN "actor_type" = 'end_user' THEN "actor_id" END
       )
 WHERE "subject_end_user_id" IS NULL;

CREATE INDEX "security_events_application_id_subject_end_user_id_created__idx"
    ON "security_events"("application_id", "subject_end_user_id", "created_at");
