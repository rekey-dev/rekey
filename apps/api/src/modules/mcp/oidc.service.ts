/**
 * Per-Application OpenID Connect provider.
 *
 * Rekey's per-app OAuth 2.1 authorization server (oauth.service.ts, originally
 * built to front the hosted MCP server) doubles as an OpenID Provider when the
 * Application sets `authConfig.oidcEnabled`. This file holds only the OIDC half:
 * the discovery document, the identity claims, and ID Token minting. The grant
 * itself — clients, authorization codes, PKCE, the token endpoint — is the same
 * one MCP uses and is NOT duplicated here.
 *
 * Standards:
 *   - OpenID Connect Core 1.0        ID Token, UserInfo, scope→claim mapping
 *   - OpenID Connect Discovery 1.0   /.well-known/openid-configuration
 *   - RFC 8414 §3.1                  path-insertion form of the same document
 *
 * Deliberately imports nothing from oauth.service.ts (the dependency runs the
 * other way): every issuer/scope input arrives as an argument, so the two files
 * stay acyclic and each piece is unit-testable on its own.
 */

import type { EndUser } from '@prisma/client';
import { getActiveSigningKey } from '../../lib/signing-keys.js';
import { issueIdToken } from '../../lib/jwt.js';
import { profileClaims } from '../../lib/oidc-profile.js';

/** The scope that makes a request an OpenID Connect request (OIDC Core §3.1.2.1). */
export const OPENID_SCOPE = 'openid';
/** Optional scope: display-name-ish claims (OIDC Core §5.4). */
export const PROFILE_SCOPE = 'profile';
/** Optional scope: `email` + `email_verified` (OIDC Core §5.4). */
export const EMAIL_SCOPE = 'email';

/** Every OIDC scope this provider recognises, in metadata-advertised order. */
export const OIDC_SCOPES_SUPPORTED = [OPENID_SCOPE, PROFILE_SCOPE, EMAIL_SCOPE] as const;

/** The ID Token's own structural claims — emitted for every grant. */
const STRUCTURAL_CLAIMS = [
  'iss',
  'sub',
  'aud',
  'exp',
  'iat',
  'auth_time',
  'nonce',
  'at_hash',
] as const;

/** What each optional scope adds, in the order `claims_supported` lists them. */
const CLAIMS_BY_SCOPE: Record<string, readonly string[]> = {
  [PROFILE_SCOPE]: [
    'name',
    'given_name',
    'family_name',
    'preferred_username',
    'picture',
    'updated_at',
  ],
  [EMAIL_SCOPE]: ['email', 'email_verified'],
};

export interface OidcDiscoveryInput {
  /** The authorization server's issuer URL — identical to `iss` on ID Tokens. */
  issuer: string;
  /** Deployment-wide JWKS (RS256 public keys); there is exactly one. */
  jwksUri: string;
  /** Every scope this Application's AS will actually grant, `openid` included. */
  scopesSupported: string[];
  /**
   * Whether `POST /oauth/register` is open. Absent from the document when it
   * is not: RFC 8414 makes `registration_endpoint` optional, and advertising a
   * URL that answers 403 is worse than advertising nothing.
   */
  registrationEndpoint?: string | undefined;
}

/**
 * `claims_supported` derived from the scopes this Application really grants,
 * not from a fixed list.
 *
 * A hint rather than a promise for any given user (an Application that never
 * stores a display name simply never emits `name`) — but it must not name
 * claims that are unreachable in principle. `email` is grantable only when the
 * Application requires verified addresses, so an Application that does not must
 * not list `email` here either; a client that reads it and keys accounts on the
 * claim has been told something false.
 */
function claimsSupported(scopesSupported: string[]): string[] {
  const claims: string[] = [...STRUCTURAL_CLAIMS];
  for (const scope of scopesSupported) {
    const added = CLAIMS_BY_SCOPE[scope];
    if (added) claims.push(...added);
  }
  return claims;
}

/**
 * OpenID Provider Metadata (OIDC Discovery 1.0 §3).
 *
 * Every field below describes something this deployment really does. Nothing is
 * copied from a reference document: a client that trusts `prompt` or the
 * `request` parameter because the metadata mentioned it would fail at the
 * authorization endpoint, so the unsupported features are advertised as
 * unsupported instead of omitted (`*_parameter_supported: false`) and the
 * authorization endpoint returns the spec's error for each.
 */
export function oidcDiscoveryDocument(input: OidcDiscoveryInput): Record<string, unknown> {
  const { issuer } = input;
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: input.jwksUri,
    ...(input.registrationEndpoint !== undefined && {
      registration_endpoint: input.registrationEndpoint,
    }),
    introspection_endpoint: `${issuer}/oauth/introspect`,
    scopes_supported: input.scopesSupported,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // `public` — `sub` is the EndUser id, the same value for every client of
    // this Application. Pairwise would buy nothing: EndUser rows are already
    // per-Application, so two Applications never share a subject identifier.
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    // Public clients proving themselves with PKCE — no client secrets exist.
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: claimsSupported(input.scopesSupported),
    // No `claims` request parameter, no request objects. Stated explicitly so a
    // client does not have to discover it by getting an error.
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    require_request_uri_registration: false,
  };
}

/** Split a space-separated scope string (RFC 6749 §3.3) into a set. */
export function scopeSet(scope: string | undefined | null): Set<string> {
  return new Set((scope ?? '').split(/\s+/).filter(Boolean));
}

/** Was `want` granted? */
export function hasScope(scope: string | undefined | null, want: string): boolean {
  return scopeSet(scope).has(want);
}

/**
 * Identity claims for a granted scope string, for both `/userinfo` and the ID
 * Token. `sub` is unconditional (OIDC Core §5.3.2 requires it in the UserInfo
 * response); every other claim is gated on the scope that authorises it, so a
 * client granted bare `openid` learns an opaque identifier and nothing else.
 *
 * Returns nothing for an erased end-user's PII by construction — erasure nulls
 * `metadata` and tombstones the email — but callers reject those tokens outright
 * (see the `/userinfo` handler) rather than relying on that.
 */
export function identityClaims(
  user: Pick<EndUser, 'id' | 'email' | 'emailVerified' | 'metadata' | 'updatedAt'>,
  scope: string,
): Record<string, unknown> {
  const granted = scopeSet(scope);
  const claims: Record<string, unknown> = { sub: user.id };

  // The address is asserted only when somebody proved it. `email` is grantable
  // only on an Application with `requireEmailVerification` (see
  // `supportedScopes`), so in practice this cannot be false — but the granted
  // scope string rides a 30-day refresh chain, and an operator who switches the
  // requirement back off must not thereby start shipping unproven addresses
  // down tokens that were already issued. `email_verified` is consequently
  // always `true`: a relying party that ignores it, as most do, is now no worse
  // off than one that reads it.
  if (granted.has(EMAIL_SCOPE) && user.emailVerified) {
    claims.email = user.email;
    claims.email_verified = true;
  }

  if (granted.has(PROFILE_SCOPE)) {
    // Operator-written namespace only — the end-user's own free-form metadata
    // is not an identity assertion. See lib/oidc-profile.ts.
    Object.assign(claims, profileClaims(user.metadata));
    // Not from metadata: `updated_at` is a real column, and OIDC defines it as
    // seconds since the epoch (not an ISO string like the rest of our API).
    claims.updated_at = Math.floor(user.updatedAt.getTime() / 1000);
  }

  return claims;
}

export interface IssueIdTokenForGrantInput {
  issuer: string;
  clientId: string;
  user: Pick<EndUser, 'id' | 'email' | 'emailVerified' | 'metadata' | 'updatedAt'>;
  /** The GRANTED scope string — never the requested one. */
  scope: string;
  authTime: Date;
  nonce?: string | undefined;
  accessToken?: string | undefined;
}

/**
 * Mint the ID Token for a completed grant, signed with the deployment's active
 * JWKS key.
 *
 * The identity claims ride along in the ID Token as well as being served from
 * `/userinfo`. OIDC Core §5.4 says the `profile`/`email` claims "are returned
 * from the UserInfo Endpoint" for flows that issue an access token; putting
 * them in the token too is a deliberate deviation, matching what every major
 * provider does, and it saves a round-trip on the callback that most relying
 * parties would otherwise make immediately. The scope gate is identical in both
 * places, so it discloses nothing `/userinfo` wouldn't.
 */
export async function issueIdTokenForGrant(
  input: IssueIdTokenForGrantInput,
): Promise<{ token: string; expiresAt: Date }> {
  const key = await getActiveSigningKey();
  const { sub: _sub, ...claims } = identityClaims(input.user, input.scope);
  return issueIdToken({
    issuer: input.issuer,
    endUserId: input.user.id,
    clientId: input.clientId,
    key,
    authTime: input.authTime,
    nonce: input.nonce,
    accessToken: input.accessToken,
    claims,
  });
}
