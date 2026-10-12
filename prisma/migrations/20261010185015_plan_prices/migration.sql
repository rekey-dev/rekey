-- AlterTable
ALTER TABLE "checkout_sessions" ADD COLUMN     "plan_price_id" TEXT;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "plan_price_id" TEXT;

-- CreateTable
CREATE TABLE "plan_prices" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "registration_status" "PlanRegistrationStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "registration_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_prices_application_id_idx" ON "plan_prices"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_prices_plan_id_currency_key" ON "plan_prices"("plan_id", "currency");

-- CreateIndex
CREATE INDEX "checkout_sessions_plan_price_id_idx" ON "checkout_sessions"("plan_price_id");

-- CreateIndex
CREATE INDEX "subscriptions_plan_price_id_idx" ON "subscriptions"("plan_price_id");

-- AddForeignKey
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_price_id_fkey" FOREIGN KEY ("plan_price_id") REFERENCES "plan_prices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_plan_price_id_fkey" FOREIGN KEY ("plan_price_id") REFERENCES "plan_prices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
