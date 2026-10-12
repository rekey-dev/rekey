-- Data only. Says which price a payment was for, which provider took it and
-- whether it was ever matched, where existing rows can answer.
--
-- Assumes:
--   - A payment that took money (SUCCEEDED, or since refunded) in its
--     subscription's currency was a charge for that subscription's price. A
--     FAILED or PENDING payment, one in another currency and one with an open
--     unapplied case are left unlinked: none can be attached to a price
--     without guessing.
--   - `unit_amount` is the price at the time of the charge, which only the
--     payment's own amount can show. It is written where the payment was for
--     exactly what the subscription pays, and left empty otherwise (a
--     discounted charge, or a subscription re-priced since).
--   - A payment with an open unapplied case was never matched to anything, so
--     it is UNVERIFIED. Every other existing payment keeps the column default.
--   - The provider is the subscription's, or else the one recorded on the
--     payment's unapplied case.
--   - A payment with no subscription and no case stays as it is.
--   - `payments.currency` is never changed, even where it is the old USD
--     default on a row that named none.
--
-- Guarded by the columns being empty, so a second run changes nothing.
UPDATE "payments" AS pay
   SET "plan_price_id" = s."plan_price_id",
       "unit_amount" = CASE WHEN pay."amount" = s."unit_amount" THEN s."unit_amount" END
  FROM "subscriptions" AS s
 WHERE s."id" = pay."subscription_id"
   AND s."application_id" = pay."application_id"
   AND pay."plan_price_id" IS NULL
   AND pay."unit_amount" IS NULL
   AND pay."status" IN ('SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED')
   AND s."plan_price_id" IS NOT NULL
   AND upper(pay."currency") = upper(s."currency")
   AND NOT EXISTS (
     SELECT 1 FROM "unapplied_payments" AS u
      WHERE u."payment_id" = pay."id" AND u."status" = 'OPEN'
   );

UPDATE "payments" AS pay
   SET "verification" = 'UNVERIFIED'
  FROM "unapplied_payments" AS u
 WHERE u."payment_id" = pay."id"
   AND u."application_id" = pay."application_id"
   AND u."status" = 'OPEN'
   AND pay."verification" = 'VERIFIED';

UPDATE "payments" AS pay
   SET "provider" = s."provider"
  FROM "subscriptions" AS s
 WHERE s."id" = pay."subscription_id"
   AND s."application_id" = pay."application_id"
   AND pay."provider" IS NULL
   AND s."provider" IS NOT NULL;

UPDATE "payments" AS pay
   SET "provider" = u."provider"
  FROM "unapplied_payments" AS u
 WHERE u."payment_id" = pay."id"
   AND u."application_id" = pay."application_id"
   AND pay."provider" IS NULL;
