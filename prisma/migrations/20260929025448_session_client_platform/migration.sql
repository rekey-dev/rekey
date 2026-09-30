-- AlterTable
ALTER TABLE "end_users" ADD COLUMN     "last_country" CHAR(2),
ADD COLUMN     "last_platform" TEXT,
ADD COLUMN     "platforms_seen" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "client_app_version" TEXT,
ADD COLUMN     "client_browser" TEXT,
ADD COLUMN     "client_os" TEXT,
ADD COLUMN     "client_platform" TEXT,
ADD COLUMN     "country" CHAR(2);
