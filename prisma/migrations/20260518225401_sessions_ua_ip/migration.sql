-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "ip" TEXT,
ADD COLUMN     "user_agent" TEXT;

-- AlterTable
ALTER TABLE "tenant_refresh_tokens" ADD COLUMN     "ip" TEXT,
ADD COLUMN     "user_agent" TEXT;
