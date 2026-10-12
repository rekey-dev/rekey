-- AlterTable
ALTER TABLE "checkout_sessions" ADD COLUMN     "currency" TEXT,
ADD COLUMN     "unit_amount" INTEGER;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "currency" TEXT,
ADD COLUMN     "unit_amount" INTEGER;

-- A price is both columns or neither.
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_price_pair"
  CHECK (("currency" IS NULL) = ("unit_amount" IS NULL));
