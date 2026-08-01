-- OpenID Connect provider support on the per-Application authorization server.

-- `nonce` is replayed verbatim into the ID Token (OIDC Core §3.1.3.7); NULL
-- when the client sent none, in which case the claim is omitted entirely.
-- `auth_time` records when the end-user actually authenticated for this code,
-- so the ID Token asserts the authentication event rather than the redemption.
ALTER TABLE "oauth_auth_codes"
  ADD COLUMN "nonce" TEXT,
  ADD COLUMN "auth_time" TIMESTAMP(3);

-- Scopes granted to an MCP/OIDC refresh-token chain (space-separated, RFC 6749).
-- Nullable because the same table backs plain session refresh tokens, which
-- have no scope. The refresh grant now re-issues this exact string; NULL reads
-- as 'mcp:account', which is what it previously hard-coded for every token.
ALTER TABLE "refresh_tokens"
  ADD COLUMN "scope" TEXT;
