-- Devices: the machines an end-user signs in from, as a first-class row.
--
-- Operational note. This migration runs in one transaction and, on a large
-- deployment, holds locks for the duration: the backfill rewrites every
-- `license_activations` row, `SET NOT NULL` rescans it, the new indexes are
-- built without CONCURRENTLY (impossible inside a transaction), and the FK on
-- `refresh_tokens` validates with a full scan under a lock that blocks
-- sign-in, refresh and sign-out until commit. Small tables will not notice.
-- With millions of refresh tokens, run it in a maintenance window, or split
-- it by hand: add the columns and the constraints as NOT VALID, backfill in
-- batches, VALIDATE, then build the indexes with CONCURRENTLY and mark the
-- migration applied with `prisma migrate resolve --applied`.
--
-- Rekey already knew about machines in one place — `license_activations`,
-- keyed by `machine_fingerprint` under a license. That made a device a fact
-- about a license rather than about a person: an end-user on a subscription
-- plan (no license) could not bind a machine at all, a seat once taken could
-- never be given back, and nothing about a session said which machine minted
-- it. This migration adds the missing noun and points the two existing
-- concepts at it.
--
--   * `devices` — one row per (application, end-user, fingerprint). Unique per
--     END-USER, deliberately: the same fingerprint under two accounts is two
--     rows. Cross-account reuse is a signal for the security-events trail, not
--     a constraint the database refuses. Status ACTIVE | RELEASED | BLOCKED;
--     rows are never deleted by the API, so a released device stays visible
--     to the operator as history.
--
--   * `refresh_tokens.device_id` — the device a session was minted on, when
--     the client identified itself. Nullable and SET NULL on device delete, so
--     nothing about existing sessions changes and deleting a device row can
--     never sign anyone out by accident; releasing or blocking a device
--     revokes its sessions explicitly, in the service.
--
--   * `license_activations` gains `application_id` (every domain row carries
--     its application — this table was the one that did not, and could only
--     be addressed by joining through `licenses`), `device_id` (the device the
--     same fingerprint resolved to under the license holder) and
--     `released_at` (a seat given back stops counting toward `seats_allowed`
--     and is reactivated in place on the next verify rather than duplicated).
--
-- The `application_id` backfill is the only data change and is derived, not
-- guessed: every activation has exactly one license, and the license names
-- the application. The column is added nullable, filled from that join, then
-- made NOT NULL — so a deployment with zero activations and one with a
-- million both migrate in a single transaction.

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'RELEASED', 'BLOCKED');

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "end_user_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "label" TEXT,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_ip" TEXT,
    "released_at" TIMESTAMP(3),
    "blocked_at" TIMESTAMP(3),
    "blocked_reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "devices_application_id_end_user_id_fingerprint_key" ON "devices"("application_id", "end_user_id", "fingerprint");

-- CreateIndex
CREATE INDEX "devices_application_id_fingerprint_idx" ON "devices"("application_id", "fingerprint");

-- CreateIndex
CREATE INDEX "devices_end_user_id_status_idx" ON "devices"("end_user_id", "status");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_end_user_id_fkey" FOREIGN KEY ("end_user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: sessions remember the device that minted them.
ALTER TABLE "refresh_tokens" ADD COLUMN "device_id" TEXT;

-- CreateIndex
CREATE INDEX "refresh_tokens_device_id_idx" ON "refresh_tokens"("device_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: activations carry their application, link to a device, and can be released.
ALTER TABLE "license_activations" ADD COLUMN "application_id" TEXT;
ALTER TABLE "license_activations" ADD COLUMN "device_id" TEXT;
ALTER TABLE "license_activations" ADD COLUMN "released_at" TIMESTAMP(3);

-- Backfill application_id from the owning license. Derived, never guessed.
UPDATE "license_activations" AS la
SET "application_id" = l."application_id"
FROM "licenses" AS l
WHERE l."id" = la."license_id";

ALTER TABLE "license_activations" ALTER COLUMN "application_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "license_activations_application_id_machine_fingerprint_idx" ON "license_activations"("application_id", "machine_fingerprint");

-- CreateIndex
CREATE INDEX "license_activations_device_id_idx" ON "license_activations"("device_id");

-- AddForeignKey
ALTER TABLE "license_activations" ADD CONSTRAINT "license_activations_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
