-- The lockout and throttle counters on these three tables have had no reader
-- since lockout moved to the Redis brute-force limiter. They were kept to
-- avoid a destructive migration; this is that migration. Nothing is copied:
-- the limiter holds the live state.

-- AlterTable
ALTER TABLE "mfa_credentials" DROP COLUMN "failed_attempts",
DROP COLUMN "locked_until";

-- AlterTable
ALTER TABLE "tenant_mfa_credentials" DROP COLUMN "failed_attempts",
DROP COLUMN "locked_until";

-- AlterTable
ALTER TABLE "tenant_users" DROP COLUMN "failed_sign_in_attempts",
DROP COLUMN "locked_until";
