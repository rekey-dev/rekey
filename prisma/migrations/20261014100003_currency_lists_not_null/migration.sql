-- Billing money model, contract step 3 of 6: a currency list is never NULL.
--
-- Both columns were added nullable with an empty default. The API has always
-- read NULL as the empty list, so writing the empty list in its place changes
-- what no row means: for a provider, none; for a coupon, any.
--
-- Prisma cannot describe NOT NULL on a list column, so it lives only here.

UPDATE "billing_credentials" SET "currencies" = ARRAY[]::TEXT[] WHERE "currencies" IS NULL;
ALTER TABLE "billing_credentials" ALTER COLUMN "currencies" SET NOT NULL;

UPDATE "coupons" SET "currencies" = ARRAY[]::TEXT[] WHERE "currencies" IS NULL;
ALTER TABLE "coupons" ALTER COLUMN "currencies" SET NOT NULL;
