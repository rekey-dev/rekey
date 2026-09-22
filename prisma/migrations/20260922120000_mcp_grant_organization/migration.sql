-- An MCP (`mcp:account`) grant can act for one of the end-user's
-- organizations, chosen at consent. The choice rides on the authorization code
-- and then on the refresh chain.
--
-- Both columns are nullable with no default, so adding them rewrites nothing
-- and existing rows (every grant made before this) read as personal, exactly
-- what they were. No foreign key and no index: the id is never looked up by
-- column, only re-checked against organization_memberships on use, and an id
-- whose organization was deleted must fail that check rather than be nulled
-- into a personal grant.
ALTER TABLE "oauth_auth_codes" ADD COLUMN "organization_id" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "grant_organization_id" TEXT;
