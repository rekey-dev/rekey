-- Operator MCP refresh tokens now record the scopes granted to the token chain
-- (space-separated, RFC 6749). Carried across rotations so a refresh_token grant
-- can never silently widen or drop the scope. Existing rows are read-only by
-- default — matching the only scope issued before write capability existed.
ALTER TABLE "tenant_mcp_refresh_tokens"
  ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'mcp:operator:read';
