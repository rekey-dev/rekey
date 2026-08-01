-- Per-workspace resource ceilings, super-admin-settable. Nullable with no
-- default: existing rows stay NULL and NULL means UNLIMITED, so applying this
-- cannot change the behaviour of a running deployment.
-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "limits" JSONB;
