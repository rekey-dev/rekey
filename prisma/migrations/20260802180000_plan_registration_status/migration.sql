-- Plan provider-registration status.
--
-- `POST /plans` used to insert the row and THEN register it with the payment
-- processor. A provider refusal (bad API key, rejected currency) left the plan
-- committed and `active = true`, so it stayed on the public pricing page with
-- nothing on the row to distinguish it from a working plan, and every buyer who
-- clicked it got a 500 out of checkout. The insert now happens in an explicitly
-- un-purchasable state and is only promoted once the provider answers.
--
-- BACKFILL. Existing rows predate the column and must not all become PENDING —
-- that would take every live plan off the catalogue. Two honest populations:
--
--   * `metadata -> 'stripe' ->> 'priceId'` present  → REGISTERED. The eager
--     Stripe registration ran and stored the price id.
--   * everything else → NOT_REQUIRED. Either the Application has no Stripe
--     credentials (PayPal/Razorpay register lazily at first checkout, and
--     neither persists an id back onto the row), or it is one of the plans this
--     bug produced. The latter now surfaces at checkout as
--     PLAN_NOT_REGISTERED_WITH_PROVIDER — a 409 naming the repair — instead of
--     an uncaught 500, and is fixable with
--     POST /api/v1/tenant/applications/:id/plans/:slug/register.
--
-- Deliberately NOT marking the second group FAILED: this migration cannot tell
-- a broken Stripe plan from a perfectly healthy Razorpay one, and guessing
-- FAILED would deactivate working plans — an outage of the operator's pricing
-- page in the name of fixing it.

CREATE TYPE "PlanRegistrationStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'REGISTERED', 'FAILED');

ALTER TABLE "plans"
  ADD COLUMN "registration_status" "PlanRegistrationStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "registration_error" TEXT;

UPDATE "plans"
   SET "registration_status" = 'REGISTERED'
 WHERE "metadata" -> 'stripe' ->> 'priceId' IS NOT NULL;
