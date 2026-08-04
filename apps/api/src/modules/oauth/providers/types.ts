/**
 * OAuth provider interface.
 *
 * Each provider (Google, GitHub, …) implements this. The OAuth surface in
 * `oauth.routes.ts` is provider-agnostic; the routes look up the right
 * implementation from `getOAuthProvider(name)` and dispatch.
 *
 * The interface is the *intersection* of what we'll support across providers:
 *   - Build an authorization URL we redirect the user to.
 *   - Exchange the callback `code` for the user's email + provider id.
 *
 * Provider-specific niceties (refresh tokens, profile photos, scope grants)
 * stay inside the implementation. Keep this surface minimal.
 */

export interface OAuthProviderConfig {
  /** Public client identifier from the provider's developer console. */
  clientId: string;
  /** Confidential. Stored encrypted on Application.oauthCredentialsCiphertext. */
  clientSecret: string;
  /** Where the provider redirects after consent. Must match what's registered upstream. */
  redirectUri: string;
  /**
   * Generic OIDC issuer URL (e.g. `https://login.example.com`). Required by
   * the `oidc` provider; ignored by static providers (google, github, …).
   * The `oidc` provider fetches `${issuerUrl}/.well-known/openid-configuration`
   * to discover authorization + token endpoints.
   */
  issuerUrl?: string;
}

export interface BuildAuthUrlInput {
  config: OAuthProviderConfig;
  /** Opaque CSRF state — we round-trip it through the provider. */
  state: string;
  /** Optional scope override. Falls back to provider default. */
  scopes?: string[];
  /**
   * PKCE verifier (RFC 7636). The provider derives the `code_challenge` from
   * it and only sends one if the issuer advertises S256 — see `oidc.ts`. The
   * CALLER owns this value and must present the same one at exchange, so it
   * has to survive the redirect; storing it against `state` is what the
   * operator OAuth service does.
   */
  codeVerifier?: string;
}

export interface ExchangeInput {
  config: OAuthProviderConfig;
  /** The `code` query param returned to our callback URL. */
  code: string;
  /**
   * PKCE verifier — must be the same value whose challenge was sent on
   * authorize. Was declared here long before anything sent one; `oidc.ts` now
   * does, when the issuer advertises S256.
   */
  codeVerifier?: string;
}

export interface OAuthIdentityResult {
  /** Stable provider-side account id (Google `sub`, GitHub user id, …). */
  providerAccountId: string;
  /** Best-effort email from the provider. May be null if scopes don't include it. */
  email: string | null;
  /**
   * True iff the provider asserts the email is verified (e.g. id_token's
   * `email_verified === true`, GitHub `/user/emails` `verified: true`).
   *
   * **Load-bearing for auto-link.** The OAuth service refuses to link a
   * new provider account to an existing EndUser by email unless this is
   * true — an attacker who controls an unverified email at a provider
   * could otherwise hijack an existing password account by signing in
   * with OAuth and claiming the same email.
   *
   * Providers that cannot determine verification status MUST set this to
   * `false` (the safe default). Never default `true`.
   */
  emailVerified: boolean;
}

export interface OAuthProvider {
  /** Stable name — `"google"`, `"github"`, … */
  readonly name: string;
  buildAuthUrl(input: BuildAuthUrlInput): string;
  exchange(input: ExchangeInput): Promise<OAuthIdentityResult>;
}
