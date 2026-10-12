-- Data only. `plans.is_free` takes the answer the API computes today: a plan
-- is free when its amount is 0 and it has no per-unit price.
--
-- Assumes a metered plan at amount 0 is NOT free. Without the flag, dropping
-- `price_per_unit_cents` later would turn those plans into free ones that any
-- signed-in user can activate.
--
-- Guarded on the current value, so a second run changes nothing.
UPDATE "plans"
   SET "is_free" = true
 WHERE "is_free" = false
   AND "amount" = 0
   AND "price_per_unit_cents" IS NULL;

UPDATE "plans"
   SET "is_free" = false
 WHERE "is_free" = true
   AND NOT ("amount" = 0 AND "price_per_unit_cents" IS NULL);
