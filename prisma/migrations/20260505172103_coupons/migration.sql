-- CreateEnum
CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENT', 'AMOUNT');

-- CreateTable
CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "discount_type" "CouponDiscountType" NOT NULL,
    "amount_off" INTEGER NOT NULL,
    "currency" TEXT,
    "plan_slugs" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "max_redemptions" INTEGER,
    "max_redemptions_per_user" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_redemptions" (
    "id" TEXT NOT NULL,
    "coupon_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "subscription_id" TEXT,
    "payment_id" TEXT,
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coupons_application_id_idx" ON "coupons"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_application_id_code_key" ON "coupons"("application_id", "code");

-- CreateIndex
CREATE INDEX "coupon_redemptions_coupon_id_idx" ON "coupon_redemptions"("coupon_id");

-- CreateIndex
CREATE INDEX "coupon_redemptions_application_id_end_user_id_idx" ON "coupon_redemptions"("application_id", "end_user_id");

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
