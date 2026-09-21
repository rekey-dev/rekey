-- Operator scopes on the membership.
--
-- The member's ceiling, workspace-wide. Two columns rather than one nullable
-- array, because Prisma list fields cannot be null: `scopes_restricted` is the
-- switch, `scopes` is the set. Every pre-existing row gets `false` + `{}`, which
-- resolves to "every scope in the registry" — exactly what a member has today.
-- Applying this changes nothing until an admin restricts somebody.
--
-- Constant defaults, no table rewrite on PG 11+.
ALTER TABLE "tenant_memberships"
  ADD COLUMN "scopes_restricted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
