-- CreateIndex
CREATE UNIQUE INDEX "coupon_redemptions_coupon_id_payment_id_key" ON "coupon_redemptions"("coupon_id", "payment_id");
