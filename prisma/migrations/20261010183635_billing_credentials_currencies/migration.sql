-- AlterTable
ALTER TABLE "billing_credentials" ADD COLUMN     "currencies" TEXT[] DEFAULT ARRAY[]::TEXT[];
