-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "profile_schema" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "end_users" ADD COLUMN     "onboarding_completed_at" TIMESTAMP(3),
ADD COLUMN     "profile" JSONB NOT NULL DEFAULT '{}';
