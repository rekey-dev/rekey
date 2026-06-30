-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "ip_allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "cors_origins" TEXT[] DEFAULT ARRAY[]::TEXT[];
