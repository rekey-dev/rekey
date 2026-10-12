-- Billing money model 2, expand step 2 of 3: the price a payment, a checkout
-- and a credit grant were for, refunds as rows, and a coupon amount per
-- currency. Every new column is nullable or defaulted.

-- CreateEnum
CREATE TYPE "PaymentVerification" AS ENUM ('VERIFIED', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundInitiator" AS ENUM ('OPERATOR', 'PROVIDER', 'SYSTEM');

-- AlterTable
ALTER TABLE "checkout_sessions" ADD COLUMN     "charge_amount" INTEGER,
ADD COLUMN     "discount_amount" INTEGER;

-- AlterTable
ALTER TABLE "coupons" ADD COLUMN     "currencies" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "credit_ledger" ADD COLUMN     "payment_id" TEXT,
ADD COLUMN     "plan_price_id" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "discount_amount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "plan_price_id" TEXT,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "provider_charge_id" TEXT,
ADD COLUMN     "unit_amount" INTEGER,
ADD COLUMN     "verification" "PaymentVerification" NOT NULL DEFAULT 'VERIFIED';

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "provider_refund_id" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "initiated_by" "RefundInitiator" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_amounts" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "coupon_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount_off" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_amounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refunds_payment_id_idx" ON "refunds"("payment_id");

-- CreateIndex
CREATE INDEX "refunds_application_id_created_at_idx" ON "refunds"("application_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_application_id_provider_refund_id_key" ON "refunds"("application_id", "provider_refund_id");

-- CreateIndex
CREATE INDEX "coupon_amounts_application_id_idx" ON "coupon_amounts"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_amounts_coupon_id_currency_key" ON "coupon_amounts"("coupon_id", "currency");

-- CreateIndex
CREATE INDEX "credit_ledger_payment_id_idx" ON "credit_ledger"("payment_id");

-- CreateIndex
CREATE INDEX "credit_ledger_plan_price_id_idx" ON "credit_ledger"("plan_price_id");

-- CreateIndex
CREATE INDEX "payments_plan_price_id_idx" ON "payments"("plan_price_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_plan_price_id_fkey" FOREIGN KEY ("plan_price_id") REFERENCES "plan_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_plan_price_id_fkey" FOREIGN KEY ("plan_price_id") REFERENCES "plan_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_amounts" ADD CONSTRAINT "coupon_amounts_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_amounts" ADD CONSTRAINT "coupon_amounts_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
