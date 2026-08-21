-- Organization role catalog + role-naming hygiene.
--
-- Three things happen here, none of them destructive. The generated diff for
-- this schema change wanted to DROP the `end_user_roles` table and both `role`
-- columns and recreate them; every statement below is a rename or an in-place
-- type change instead, so no row loses data.
--
--  1. `ApplicationRole` (the enum on `application_grants`) becomes
--     `ApplicationGrantRole`. It always described the role held BY a grant, and
--     the old name is now needed for the end-user-facing role catalog.
--  2. `end_user_roles` becomes `application_roles`. Same table, same rows. The
--     name now says which axis it governs (app-wide, one per (app, end-user)),
--     so it cannot be confused with the org-scoped axis added below.
--  3. Organization roles stop being a fixed enum and become a per-Application
--     catalog. `organization_memberships.role` and
--     `organization_invitations.role` become TEXT holding a catalog NAME; the
--     old enum type is renamed to `OrganizationBaseRole` and lives on in
--     `organization_roles.base_role`, which is the tier Rekey's own gates read.
--     Existing rows already hold 'OWNER' / 'ADMIN' / 'MEMBER', which are exactly
--     the built-in catalog names seeded at the bottom, so every existing
--     membership keeps working with no value rewrite.

-- LOCKS AND DEPLOY ORDER. Step 3a converts two enum columns to TEXT, which is
-- not binary-coercible: Postgres rewrites both tables and rebuilds their
-- indexes while holding ACCESS EXCLUSIVE. Prisma runs this file in a single
-- transaction, so those locks are held until the seed at the bottom commits,
-- and `organization_memberships` / `organization_invitations` are unavailable
-- for reads as well as writes for the duration.
--
-- `lock_timeout` bounds the damage. Without it, one long-running transaction
-- from a still-draining old container blocks the ALTER, and every query
-- arriving behind it queues behind that too: a stall that outlasts the
-- deployment. With it, the migration fails fast and cleanly (the whole file
-- rolls back) and can be retried once the blocker is gone.
--
-- Old code cannot run against the new schema: the `ApplicationRole` and
-- `OrganizationRole` types and the `end_user_roles` table are all gone, and
-- Prisma emits explicit enum casts. Stop the previous API container before the
-- new one migrates; do not run them side by side.
--
-- If the migration is interrupted, the DDL rolls back but a failed row is left
-- in `_prisma_migrations`, which blocks every later migration and crash-loops
-- the container. Recover with `prisma migrate resolve --rolled-back
-- 20260820113000_organization_role_catalog`, then redeploy.
SET lock_timeout = '10s';

-- 1. ApplicationRole -> ApplicationGrantRole (type rename keeps the column).
ALTER TYPE "ApplicationRole" RENAME TO "ApplicationGrantRole";

-- 2. end_user_roles -> application_roles. Postgres does not rename a table's
--    indexes or constraints along with it, so each is renamed explicitly.
--    Otherwise `migrate diff` reports a permanent drift on every later PR.
ALTER TABLE "end_user_roles" RENAME TO "application_roles";
ALTER TABLE "application_roles" RENAME CONSTRAINT "end_user_roles_pkey" TO "application_roles_pkey";
ALTER TABLE "application_roles" RENAME CONSTRAINT "end_user_roles_application_id_fkey" TO "application_roles_application_id_fkey";
ALTER INDEX "end_user_roles_application_id_idx" RENAME TO "application_roles_application_id_idx";
ALTER INDEX "end_user_roles_application_id_name_key" RENAME TO "application_roles_application_id_name_key";

-- 3a. Membership / invitation role: enum -> TEXT, preserving the literal value.
ALTER TABLE "organization_memberships" ALTER COLUMN "role" TYPE TEXT USING "role"::TEXT;
ALTER TABLE "organization_invitations" ALTER COLUMN "role" TYPE TEXT USING "role"::TEXT;

-- 3b. The enum survives as the authority tier. Renamed rather than dropped and
--     recreated so nothing depending on the type OID has to be rebuilt.
ALTER TYPE "OrganizationRole" RENAME TO "OrganizationBaseRole";

-- 3c. The catalog itself.
CREATE TABLE "organization_roles" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "base_role" "OrganizationBaseRole" NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_roles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "organization_roles_application_id_idx" ON "organization_roles"("application_id");
CREATE UNIQUE INDEX "organization_roles_application_id_name_key" ON "organization_roles"("application_id", "name");

ALTER TABLE "organization_roles" ADD CONSTRAINT "organization_roles_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3d. Seed the three built-ins for every Application that already exists.
--     New Applications get the same three rows from applications.service.create,
--     in the same transaction as the Application itself.
INSERT INTO "organization_roles"
  ("id", "application_id", "name", "description", "base_role", "is_default", "is_built_in", "created_at", "updated_at")
SELECT
  gen_random_uuid()::text,
  a."id",
  r."name",
  r."description",
  r."base_role"::"OrganizationBaseRole",
  r."is_default",
  true,
  NOW(),
  NOW()
FROM "applications" a
CROSS JOIN (VALUES
  ('OWNER',  'Full control: manage the organization, its members and ownership transfer.', 'OWNER',  false),
  ('ADMIN',  'Manage members below OWNER, and the organization profile.',                  'ADMIN',  false),
  ('MEMBER', 'Read-only access to the organization.',                                      'MEMBER', true)
) AS r("name", "description", "base_role", "is_default");
