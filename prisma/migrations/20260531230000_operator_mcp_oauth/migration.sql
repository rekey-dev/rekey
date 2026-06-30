-- Operator MCP OAuth — Phase 2.
--
-- Three new tables mounted under /api/v1/tenant/mcp/oauth/*:
--   tenant_oauth_clients         RFC 7591 dynamic-registered MCP clients
--   tenant_oauth_auth_codes      single-use PKCE-anchored authorization codes
--   tenant_mcp_refresh_tokens    hash-only, rotated-on-redeem refresh tokens
--
-- Schema mirrors the per-Application MCP OAuth tables (oauth_clients /
-- oauth_auth_codes) but binds tokens to (tenant_user_id, tenant_id) rather
-- than (application_id, end_user_id).
--
-- IF NOT EXISTS on every CREATE so a re-applied migration is a no-op.

CREATE TABLE IF NOT EXISTS "tenant_oauth_clients" (
  "id" TEXT PRIMARY KEY,
  "client_name" TEXT,
  "redirect_uris" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "tenant_oauth_auth_codes" (
  "id" TEXT PRIMARY KEY,
  "code_hash" TEXT NOT NULL UNIQUE,
  "client_id" TEXT NOT NULL REFERENCES "tenant_oauth_clients"("id") ON DELETE CASCADE,
  "tenant_user_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "redirect_uri" TEXT NOT NULL,
  "code_challenge" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "tenant_oauth_auth_codes_client_id_idx" ON "tenant_oauth_auth_codes"("client_id");
CREATE INDEX IF NOT EXISTS "tenant_oauth_auth_codes_expires_at_idx" ON "tenant_oauth_auth_codes"("expires_at");

CREATE TABLE IF NOT EXISTS "tenant_mcp_refresh_tokens" (
  "id" TEXT PRIMARY KEY,
  "token_hash" TEXT NOT NULL UNIQUE,
  "tenant_user_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  "replaced_by_id" TEXT,
  "user_agent" TEXT,
  "ip" TEXT
);

CREATE INDEX IF NOT EXISTS "tenant_mcp_refresh_tokens_tenant_user_id_idx" ON "tenant_mcp_refresh_tokens"("tenant_user_id");
CREATE INDEX IF NOT EXISTS "tenant_mcp_refresh_tokens_tenant_id_idx" ON "tenant_mcp_refresh_tokens"("tenant_id");
CREATE INDEX IF NOT EXISTS "tenant_mcp_refresh_tokens_client_id_idx" ON "tenant_mcp_refresh_tokens"("client_id");
CREATE INDEX IF NOT EXISTS "tenant_mcp_refresh_tokens_expires_at_idx" ON "tenant_mcp_refresh_tokens"("expires_at");
