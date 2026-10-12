-- CreateEnum
CREATE TYPE "SupportCaseStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportCaseScope" AS ENUM ('USER', 'DEVICES');

-- CreateTable
CREATE TABLE "support_cases" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
    "capabilities" TEXT[],
    "scope" "SupportCaseScope" NOT NULL DEFAULT 'USER',
    "device_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT,
    "opened_by" TEXT,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by" TEXT,
    "closed_at" TIMESTAMP(3),
    "closed_cause" TEXT,

    CONSTRAINT "support_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_capabilities" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_cases_application_id_status_opened_at_idx" ON "support_cases"("application_id", "status", "opened_at");

-- CreateIndex
CREATE INDEX "support_cases_application_id_end_user_id_opened_at_idx" ON "support_cases"("application_id", "end_user_id", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_capabilities_application_id_name_key" ON "support_capabilities"("application_id", "name");

-- At most one OPEN support case per end-user. The service serialises opens on
-- the end-user row lock and answers SUPPORT_CASE_ALREADY_OPEN itself; the index
-- keeps the rule true for any writer that skips the service.
--
-- Prisma 6 cannot describe a partial index, and `prisma migrate diff` ignores
-- one, so it lives only here. schema.prisma documents it on SupportCase.
CREATE UNIQUE INDEX "support_cases_end_user_open_key"
  ON "support_cases" ("application_id", "end_user_id")
  WHERE "status" = 'OPEN';
