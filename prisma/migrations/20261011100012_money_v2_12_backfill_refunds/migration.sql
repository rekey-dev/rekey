-- Data only. Gives every payment that has recorded a refund one refund row
-- for the total refunded so far. The payment kept only that running total,
-- so the refunds that made it up cannot be told apart.
--
-- Assumes:
--   - `payments.refunded_amount` is money that went back, in the payment's
--     currency. The row is SUCCEEDED and dated by the payment's last change,
--     which is when the total was last written.
--   - Rekey issued the refund itself only by refunding an unapplied case,
--     which leaves the case REFUNDED. Such a row is OPERATOR and carries the
--     case's note. Every other refund reached Rekey as a provider event, so it
--     is PROVIDER.
--   - The provider's refund id is known only where the case's refund is the
--     whole total: the payment has applied no refund event of its own.
--   - A payment marked REFUNDED with `refunded_amount` 0 (rows from before the
--     amount was recorded) gets no row: the column does not say what went
--     back.
--   - A payment whose currency is not three letters gets no row.
--
-- Guarded by the payment having no refund row, so a second run changes
-- nothing and a refund newer code has recorded is never doubled.
INSERT INTO "refunds" (
  "id", "application_id", "payment_id", "provider_refund_id", "amount", "currency",
  "status", "reason", "initiated_by", "created_at"
)
SELECT
  'rf_' || md5(pay."id" || ':backfill'),
  pay."application_id",
  pay."id",
  CASE
    WHEN u."status" = 'REFUNDED'
     AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(pay."metadata" -> 'refundEvents') = 'array' THEN pay."metadata" -> 'refundEvents' END), 0) = 0
    THEN u."provider_refund_id"
  END,
  pay."refunded_amount",
  upper(pay."currency"),
  'SUCCEEDED',
  CASE WHEN u."status" = 'REFUNDED' THEN u."resolution_note" END,
  CASE WHEN u."status" = 'REFUNDED' THEN 'OPERATOR'::"RefundInitiator" ELSE 'PROVIDER'::"RefundInitiator" END,
  CASE WHEN u."status" = 'REFUNDED' THEN coalesce(u."resolved_at", pay."updated_at") ELSE pay."updated_at" END
FROM "payments" AS pay
LEFT JOIN "unapplied_payments" AS u
  ON u."payment_id" = pay."id" AND u."application_id" = pay."application_id"
WHERE pay."refunded_amount" > 0
  AND upper(pay."currency") ~ '^[A-Z]{3}$'
  AND NOT EXISTS (SELECT 1 FROM "refunds" AS r WHERE r."payment_id" = pay."id")
ON CONFLICT DO NOTHING;
