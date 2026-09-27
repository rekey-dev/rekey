-- CreateEnum
CREATE TYPE "CheckoutMode" AS ENUM ('REDIRECT', 'EMBEDDED');

-- CreateEnum
CREATE TYPE "CheckoutFailureMode" AS ENUM ('FALLBACK_TO_REDIRECT', 'REFUSE');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "CheckoutKind" AS ENUM ('RECURRING', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "CheckoutSessionStatus" AS ENUM ('OPEN', 'CONFIRMING', 'COMPLETE', 'EXPIRED', 'CANCELED');

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "checkout_failure_mode" "CheckoutFailureMode" NOT NULL DEFAULT 'FALLBACK_TO_REDIRECT',
ADD COLUMN     "checkout_mode_live" "CheckoutMode" NOT NULL DEFAULT 'REDIRECT',
ADD COLUMN     "checkout_mode_test" "CheckoutMode" NOT NULL DEFAULT 'REDIRECT',
ADD COLUMN     "checkout_readiness" JSONB,
ADD COLUMN     "checkout_readiness_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "checkout_sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT,
    "application_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_session_id" TEXT NOT NULL,
    "mode" "CheckoutMode" NOT NULL,
    "payment_mode" "PaymentMode" NOT NULL,
    "kind" "CheckoutKind" NOT NULL,
    "success_url" TEXT NOT NULL,
    "cancel_url" TEXT NOT NULL,
    "locale" TEXT,
    "status" "CheckoutSessionStatus" NOT NULL DEFAULT 'OPEN',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "checkout_sessions_token_hash_key" ON "checkout_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "checkout_sessions_application_id_status_idx" ON "checkout_sessions"("application_id", "status");

-- CreateIndex
CREATE INDEX "checkout_sessions_application_id_provider_session_id_idx" ON "checkout_sessions"("application_id", "provider_session_id");

-- CreateIndex
CREATE INDEX "checkout_sessions_subscription_id_idx" ON "checkout_sessions"("subscription_id");

-- CreateIndex
CREATE INDEX "checkout_sessions_expires_at_idx" ON "checkout_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "checkout_sessions_end_user_id_created_at_idx" ON "checkout_sessions"("end_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
