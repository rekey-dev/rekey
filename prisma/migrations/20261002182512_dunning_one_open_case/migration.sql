-- At most one OPEN dunning case per subscription.
--
-- A failed Stripe renewal reaches dunning twice, through invoice.payment_failed
-- and through customer.subscription.updated (past_due), and the two webhooks
-- run concurrently. The service read "is a case open?" and then inserted, so
-- both could insert: two cases, two day-0 reminders, two schedules. The
-- service now treats a conflict on this index as "already open".
--
-- Any duplicates that already exist are closed first, keeping the oldest OPEN
-- case per subscription (the one whose reminder schedule the buyer has been
-- following), or the index could not be built. They close as CANCELED, which
-- announces nothing.
--
-- Prisma 6 cannot describe a partial index, and `prisma migrate diff` ignores
-- one, so it lives only here. schema.prisma documents it on DunningCase.
UPDATE "dunning_cases"
SET "status" = 'CANCELED', "closed_at" = NOW(), "next_action_at" = NULL, "updated_at" = NOW()
WHERE "status" = 'OPEN'
  AND "id" NOT IN (
    SELECT DISTINCT ON ("subscription_id") "id"
    FROM "dunning_cases"
    WHERE "status" = 'OPEN'
    ORDER BY "subscription_id", "opened_at" ASC, "id" ASC
  );

CREATE UNIQUE INDEX "dunning_cases_subscription_open_key"
  ON "dunning_cases" ("subscription_id")
  WHERE "status" = 'OPEN';
