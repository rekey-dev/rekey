-- Scopes narrow a MEMBER only. Promotion now clears them, but a row
-- promoted to OWNER/ADMIN before that rule existed can still carry a
-- restriction nothing enforces and the scope editor (MEMBER only) cannot
-- clear. Clear those once. Touches only rows that are both promoted and
-- restricted; on a deployment that never restricted anybody this is a no-op.
UPDATE "tenant_memberships"
  SET "scopes_restricted" = false, "scopes" = ARRAY[]::TEXT[]
  WHERE "role" <> 'MEMBER' AND "scopes_restricted";
