-- DropIndex
DROP INDEX "applications_portal_domain_key";

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "portal_domain_check_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "portal_domain_checked_at" TIMESTAMP(3),
ADD COLUMN     "portal_domain_lapsed_at" TIMESTAMP(3);

-- At most one Application may hold a domain VERIFIED; any number may claim it
-- unverified, so a squatted claim cannot block the real owner. Prisma 6 cannot
-- describe a partial index and `prisma migrate diff` ignores one, so it lives
-- only here; schema.prisma notes it on the model.
CREATE UNIQUE INDEX "portal_domain_verified_key"
  ON "applications" ("portal_domain")
  WHERE "portal_domain_verified_at" IS NOT NULL;
