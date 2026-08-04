-- Grant-scoped access becomes the DEFAULT for workspace MEMBERs.
--
-- Until now, "MEMBER with zero grants" meant "read every Application in the
-- workspace". That rule was written as a migration accommodation for members
-- who predated per-application grants, but zero grants is also the state a
-- freshly accepted MEMBER invitation lands in — so the accommodation was the
-- live default, and inviting somebody as a MEMBER handed them every
-- Application's end-user roster (with emails), API-key metadata,
-- billing-credential status, payments, webhooks, coupons, licences,
-- organizations and email logs.
--
-- New column, default FALSE: every membership created from here on is
-- grant-scoped and starts with access to nothing.
ALTER TABLE "tenant_memberships"
  ADD COLUMN "legacy_workspace_read" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: GRANDFATHER the memberships that already exist.
--
-- This is deliberate, and it is the conservative half of the change. Flipping
-- every existing zero-grant MEMBER to "access nothing" would revoke, without
-- warning and without an operator ever asking, the access their colleagues are
-- using right now — an availability incident dressed as a security fix, on a
-- deployment the operator does not control the upgrade timing of. Instead the
-- old behaviour is preserved for exactly the rows that already relied on it,
-- and is now visible: `GET /api/v1/tenant/workspace/members` reports
-- `legacyWorkspaceRead` per member so an owner can find and scope them, and
-- setting any grant clears the flag permanently.
--
-- OWNER/ADMIN are untouched: they have implicit full access and never consult
-- this column.
UPDATE "tenant_memberships" SET "legacy_workspace_read" = true WHERE "role" = 'MEMBER';

-- A membership that already holds an explicit grant was never in legacy mode
-- (the first grant is what switched it to grant-scoped), so it must not be
-- grandfathered back into workspace-wide read by the line above.
UPDATE "tenant_memberships" SET "legacy_workspace_read" = false
WHERE "id" IN (SELECT DISTINCT "tenant_membership_id" FROM "application_grants");
