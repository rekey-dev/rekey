-- Applications get an `environment`; EndUser/Subscription/Payment lose `mode`.
--
-- This migration is DESTRUCTIVE by design. The `mode` columns implemented a
-- test/live split that only ever covered three of ~forty models: a TEST
-- end-user still held real Licenses, burned real CreditBalance, wrote real
-- UsageRecords, joined real Organizations and fired real WebhookEndpoints. The
-- isolation docs/api-keys.md promised did not exist, so there is nothing worth
-- preserving in these columns — carrying them forward would only preserve the
-- illusion. Isolation moves to the Application boundary, which is real: every
-- domain row already carries `application_id`.
--
-- Data loss, stated plainly: the TEST/LIVE label on existing end_users,
-- subscriptions and payments is dropped and cannot be recovered from this
-- schema. The production database is fresh (invite-only, no customers), which
-- is why a drop is acceptable here rather than a backfill into a new column.
--
-- `applications.environment` defaults to DEVELOPMENT — least privilege, so a
-- new app cannot hold live billing credentials unless someone says so at
-- creation. That default also lands on every EXISTING row this migration
-- touches. On a deployment already serving real traffic, correct them right
-- after applying:
--
--   UPDATE applications SET environment = 'PRODUCTION' WHERE slug IN (...);
--
-- SQL is the intended tool here and the only one: the column is write-once at
-- creation and no endpoint updates it. That rule has no answer for a migration
-- default landing on applications that already exist, which is exactly this
-- case. Until you run it, their newly minted API keys carry the rp_test_
-- prefix and their billing credentials cannot be re-saved in `live` mode.
--
-- Second consequence, for any database that is NOT empty: revenue numbers move.
-- Per-application billing stats used to filter to mode = 'LIVE'. With the
-- column gone they cannot, so rows previously stamped TEST now count toward
-- MRR, active-subscription counts, 30-day revenue and the 12-month series for
-- their Application. Nothing is lost or double-counted — the totals include
-- what they used to exclude. Capture the old figures BEFORE applying if you
-- need them; the mode values are unrecoverable afterwards. See DEPLOY.md
-- "Upgrading: Application environments".

/*
  Warnings:

  - You are about to drop the column `mode` on the `end_users` table. All the data in the column will be lost.
  - You are about to drop the column `mode` on the `payments` table. All the data in the column will be lost.
  - You are about to drop the column `mode` on the `subscriptions` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "AppEnvironment" AS ENUM ('PRODUCTION', 'STAGING', 'DEVELOPMENT');

-- DropIndex
DROP INDEX "end_users_application_id_mode_idx";

-- DropIndex
DROP INDEX "payments_application_id_mode_idx";

-- DropIndex
DROP INDEX "subscriptions_application_id_mode_idx";

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "environment" "AppEnvironment" NOT NULL DEFAULT 'DEVELOPMENT';

-- AlterTable
ALTER TABLE "end_users" DROP COLUMN "mode";

-- AlterTable
ALTER TABLE "payments" DROP COLUMN "mode";

-- AlterTable
ALTER TABLE "subscriptions" DROP COLUMN "mode";

-- DropEnum
DROP TYPE "DataMode";
