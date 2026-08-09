-- Restore the open-ended semantics existing grants were created under.
--
-- `grantSubscription` has always defaulted `current_period_end` to one plan
-- interval from creation when the operator did not pass one. Until the term
-- fix, nothing read that column for a provider-less row: entitlement
-- resolution filtered on status alone, and nothing swept an elapsed period.
-- So in practice every grant was open-ended, and "comp this account" meant
-- exactly that.
--
-- The term fix makes the column load-bearing, and it does so RETROACTIVELY
-- against rows already in the database. A subscription granted three months
-- ago carries a period end from two months ago, so on the first read after
-- deploy it stops entitling and is written EXPIRED — which is terminal. On a
-- deployment where checkout is disabled and every subscription is
-- hand-provisioned, that is the entire paying customer base, silently, with no
-- event emitted because `subscription.expired` does not exist.
--
-- Nulling the column for these rows preserves the behaviour they were created
-- under: the new code already treats a null period as an open-ended grant. It
-- deliberately covers every provider-less ACTIVE row rather than only the
-- elapsed ones, because a term that has not elapsed yet was equally never
-- intended to end — no grant was ever genuinely time-boxed, since nothing
-- renewed one and nothing expired one.
--
-- Provider-backed rows are untouched: there the column is a renewal date the
-- provider owns, and it has always been read.
--
-- Time-boxed grants work from here on, for subscriptions granted AFTER this
-- migration with an explicit `currentPeriodEnd`.
UPDATE "subscriptions"
SET "current_period_end" = NULL
WHERE "provider" IS NULL
  AND "provider_sub_id" IS NULL
  AND "status" = 'ACTIVE'
  AND "current_period_end" IS NOT NULL;
