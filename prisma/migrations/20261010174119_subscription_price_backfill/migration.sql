-- Subscriptions a provider is already charging keep the price their plan has
-- today, the only price a plan has had. Apart from the column change so the
-- table is not locked against readers while this runs. Rows with no provider
-- subscription (grants, free plans) are left without a price and keep
-- following their plan, as do PENDING rows until their checkout completes.
-- Guarded, so a second run changes nothing.
UPDATE "subscriptions" AS s
   SET "currency" = p."currency", "unit_amount" = p."amount"
  FROM "plans" AS p
 WHERE p."id" = s."plan_id"
   AND s."currency" IS NULL
   AND s."status" <> 'PENDING'
   AND s."provider_sub_id" IS NOT NULL;
