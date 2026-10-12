-- Data only. Copies what a checkout was to charge, and what its coupon took
-- off, from the session's metadata into columns.
--
-- Assumes:
--   - `metadata.expectedCharge.amount` (one-time checkouts only) and
--     `metadata.discountAmount` are whole numbers of minor units when present.
--     Anything else is left alone: a session with neither keeps both columns
--     null. The metadata itself is not touched; the API still reads it.
--   - A recurring checkout asks for its unit amount less its discount. Where
--     the session recorded both, that is its charge. A redirect checkout
--     recorded no discount at all, so its charge stays null: "no discount"
--     and "discount not recorded" cannot be told apart.
--
-- Guarded by the column being empty, so a second run changes nothing.
UPDATE "checkout_sessions"
   SET "charge_amount" = ("metadata" -> 'expectedCharge' ->> 'amount')::integer
 WHERE "charge_amount" IS NULL
   AND jsonb_typeof("metadata" -> 'expectedCharge' -> 'amount') = 'number'
   AND ("metadata" -> 'expectedCharge' ->> 'amount') ~ '^[0-9]{1,9}$';

UPDATE "checkout_sessions"
   SET "discount_amount" = ("metadata" ->> 'discountAmount')::integer
 WHERE "discount_amount" IS NULL
   AND jsonb_typeof("metadata" -> 'discountAmount') = 'number'
   AND ("metadata" ->> 'discountAmount') ~ '^[0-9]{1,9}$';

UPDATE "checkout_sessions"
   SET "charge_amount" = "unit_amount" - "discount_amount"
 WHERE "charge_amount" IS NULL
   AND "kind" = 'RECURRING'
   AND "unit_amount" IS NOT NULL
   AND "discount_amount" IS NOT NULL
   AND "discount_amount" <= "unit_amount";
