-- CreateEnum
CREATE TYPE "UnappliedPaymentStatus" AS ENUM ('OPEN', 'REFUNDED', 'ENTITLEMENT_GRANTED', 'DISMISSED');

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'PARTIALLY_REFUNDED';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "provider_subscription_id" TEXT,
ADD COLUMN     "refunded_amount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "unapplied_payments" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "end_user_id" TEXT,
    "provider" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "UnappliedPaymentStatus" NOT NULL DEFAULT 'OPEN',
    "resolution_note" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "provider_refund_id" TEXT,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unapplied_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unapplied_payments_payment_id_key" ON "unapplied_payments"("payment_id");

-- CreateIndex
CREATE INDEX "unapplied_payments_application_id_status_opened_at_idx" ON "unapplied_payments"("application_id", "status", "opened_at");

-- CreateIndex
CREATE INDEX "unapplied_payments_end_user_id_idx" ON "unapplied_payments"("end_user_id");

-- AddForeignKey
ALTER TABLE "unapplied_payments" ADD CONSTRAINT "unapplied_payments_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unapplied_payments" ADD CONSTRAINT "unapplied_payments_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

