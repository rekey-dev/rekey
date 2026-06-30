-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'session',
ADD COLUMN     "client_id" TEXT;
