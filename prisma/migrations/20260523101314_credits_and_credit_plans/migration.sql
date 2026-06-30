-- CreateEnum
CREATE TYPE "CreditReason" AS ENUM ('PURCHASE', 'GRANT', 'CONSUME', 'REFUND', 'ADJUST');

-- AlterEnum
ALTER TYPE "PlanKind" ADD VALUE 'CREDIT';

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "credits_amount" INTEGER;

-- CreateTable
CREATE TABLE "credit_balances" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "CreditReason" NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "idempotency_key" TEXT,
    "description" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_balances_application_id_idx" ON "credit_balances"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_balances_application_id_end_user_id_key" ON "credit_balances"("application_id", "end_user_id");

-- CreateIndex
CREATE INDEX "credit_ledger_application_id_end_user_id_idx" ON "credit_ledger"("application_id", "end_user_id");

-- CreateIndex
CREATE INDEX "credit_ledger_created_at_idx" ON "credit_ledger"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_application_id_idempotency_key_key" ON "credit_ledger"("application_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
