-- Data only. Names the payment a credit purchase was granted for, and that
-- payment's price where it has one, on the ledger rows whose own key says
-- which payment it was.
--
-- Assumes:
--   - A PURCHASE row keyed `purchase:<payment id>` was granted for that
--     payment.
--   - A PURCHASE row whose key ends `:unapplied:<case id>` was granted by
--     resolving that unapplied case, so it was for the case's payment.
--   - Every other key (a checkout session id, a billing period, `initial`)
--     names no single payment. Those rows keep `payment_id` null.
--   - The payment must belong to the ledger row's own Application.
--
-- Guarded by `payment_id` being empty, so a second run changes nothing.
UPDATE "credit_ledger" AS cl
   SET "payment_id" = pay."id",
       "plan_price_id" = coalesce(cl."plan_price_id", pay."plan_price_id")
  FROM "payments" AS pay
 WHERE cl."payment_id" IS NULL
   AND cl."reason" = 'PURCHASE'
   AND cl."idempotency_key" LIKE 'purchase:%'
   AND pay."id" = substring(cl."idempotency_key" FROM 10)
   AND pay."application_id" = cl."application_id";

UPDATE "credit_ledger" AS cl
   SET "payment_id" = pay."id",
       "plan_price_id" = coalesce(cl."plan_price_id", pay."plan_price_id")
  FROM "unapplied_payments" AS u
  JOIN "payments" AS pay ON pay."id" = u."payment_id" AND pay."application_id" = u."application_id"
 WHERE cl."payment_id" IS NULL
   AND cl."reason" = 'PURCHASE'
   AND cl."idempotency_key" LIKE 'purchase:%:unapplied:%'
   AND u."id" = substring(cl."idempotency_key" FROM ':unapplied:([^:]+)$')
   AND u."application_id" = cl."application_id";
