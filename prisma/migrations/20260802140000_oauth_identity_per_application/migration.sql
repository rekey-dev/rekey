-- OAuthIdentity uniqueness becomes per-Application.
--
-- Globally unique (provider, provider_account_id) meant the FIRST Application
-- to link a given Google/GitHub account claimed it deployment-wide: the same
-- person signing in to any other Application got a hard 401. Also a squatting
-- primitive — link an account you control and nobody else can use it.
--
-- Safe on existing data: the new key is strictly less restrictive, so any row
-- set that satisfied the old constraint satisfies this one.
DROP INDEX IF EXISTS "oauth_identities_provider_provider_account_id_key";

CREATE UNIQUE INDEX "oauth_identities_application_id_provider_provider_account_id_key"
  ON "oauth_identities" ("application_id", "provider", "provider_account_id");
