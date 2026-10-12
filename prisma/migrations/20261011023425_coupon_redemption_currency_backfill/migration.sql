-- Data only, apart from the column change so the table is not locked against
-- readers while this runs. Every statement is guarded by "currency" IS NULL,
-- so a second run changes nothing and a row a newer pod already wrote is kept.

-- A fixed-amount coupon is only ever redeemed in its own currency.
UPDATE "coupon_redemptions" AS r
   SET "currency" = upper(c."currency")
  FROM "coupons" AS c
 WHERE c."id" = r."coupon_id"
   AND r."currency" IS NULL
   AND c."discount_type" = 'AMOUNT'
   AND c."currency" IS NOT NULL;

-- A percentage coupon took its currency from the checkout. The session names
-- the price it was opened at; one older than that column was opened at the
-- plan's only price.
UPDATE "coupon_redemptions" AS r
   SET "currency" = upper(coalesce(cs."currency", p."currency"))
  FROM "checkout_sessions" AS cs
  JOIN "subscriptions" AS s ON s."id" = cs."subscription_id"
  JOIN "plans" AS p ON p."id" = s."plan_id"
 WHERE cs."application_id" = r."application_id"
   AND cs."provider_session_id" = r."checkout_session_id"
   AND r."currency" IS NULL;

-- No session row: the plan of the subscription the redemption is linked to.
-- Not the subscription's own price, which a later checkout may have replaced.
UPDATE "coupon_redemptions" AS r
   SET "currency" = upper(p."currency")
  FROM "subscriptions" AS s
  JOIN "plans" AS p ON p."id" = s."plan_id"
 WHERE s."id" = r."subscription_id"
   AND r."currency" IS NULL;
