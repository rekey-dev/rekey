-- Billing money model 2, coupons: a percentage coupon's rate gets a column of
-- its own, so `coupons.amount_off` holds nothing the API reads, and a
-- redemption records the price row it was taken off. Both columns are
-- nullable.

-- AlterTable
ALTER TABLE "coupon_redemptions" ADD COLUMN     "plan_price_id" TEXT;

-- AlterTable
ALTER TABLE "coupons" ADD COLUMN     "basis_points" INTEGER;

-- CreateIndex
CREATE INDEX "coupon_redemptions_plan_price_id_idx" ON "coupon_redemptions"("plan_price_id");

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_plan_price_id_fkey" FOREIGN KEY ("plan_price_id") REFERENCES "plan_prices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
