/**
 * End-user JWT issuance + verification.
 *
 * Token shapes (discriminated by `typ`):
 *
 *   "eu_access"        — full session access token.
 *                        { typ, sub, applicationId, iat, exp }
 *   "eu_mfa_challenge" — short-lived intermediate token issued at sign-in
 *                        when MFA is required. Holds an unauthenticated
 *                        identity; can only be exchanged at /auth/mfa-verify
 *                        for a real access+refresh pair.
 *                        { typ, sub, applicationId, iat, exp }
 *
 * The `typ` claim is load-bearing. Verifiers refuse tokens of the wrong
 * type — an `eu_mfa_challenge` MUST NOT pass as an `eu_access`, and an
 * end-user access token MUST NOT pass as an operator token (those have
 * `typ = "to_access"`, see lib/tenant-jwt.ts).
 *
 * `applicationId` is the second load-bearing claim. Request middleware
 * checks it matches the Application that the calling secret key resolved
 * to. Without that check, a token issued by Application A could be
 * presented to Application B.
 *
 * Algorithms: HS256 with a per-app derived key by default. Applications can
 * opt into RS256 access tokens (`authConfig.tokenAlg = "RS256"`) — those are
 * signed with the deployment's JWKS key (lib/signing-keys.ts, published at
 * /.well-known/jwks.json) and carry `kid` + `gen`. Verifiers accept both via
 * `verifyUserAccessTokenAnyAlg` (strict per-alg dispatch — see its docblock).
 * MFA-challenge, MCP, and impersonation tokens stay HS256 regardless.
 */

import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';
import type { Application } from '@prisma/client';
import { AuthConfigSchema } from '@relipay/shared-types';
import { env } from '../config/env.js';
import {
  getActiveSigningKey,
  getPublicKeyByKid,
  type ActiveSigningKey,
} from './signing-keys.js';

/**
 * Per-Application signing key, derived (not stored) from the root `JWT_SECRET`.
 *
 *   key = HMAC-SHA256(JWT_SECRET, `${applicationId}:${tokenGeneration}`)
 *
 * Two properties fall out of this:
 *   1. **App-scoped crypto.** A token signed for Application A can't even be
 *      verified against Application B's key — isolation no longer rests solely
 *      on the `applicationId` claim check.
 *   2. **Instant per-app session kill-switch.** Bumping `Application.tokenGeneration`
 *      changes the derived key, so every previously-issued access/challenge
 *      token for that app fails verification immediately. Pair it with a
 *      refresh-token purge (see tenant-applications `rotateSessionSecret`) for a
 *      full "log everyone out now" control. No new key material lives at rest —
 *      only a non-secret integer counter on the Application row.
 *
 * NB: after first deploy of this scheme, tokens minted under the old global
 * secret stop verifying — end-users transparently re-mint via refresh (the
 * 15-minute access token is short-lived and refresh tokens survive). A one-time
 * blip, not a logout storm.
 */
function appSigningKey(applicationId: string, tokenGeneration: number): string {
  return createHmac('sha256', env.JWT_SECRET)
    .update(`${applicationId}:${tokenGeneration}`)
    .digest('hex');
}

/**
 * Decode an end-user token WITHOUT verifying it, to read its `applicationId`
 * claim. Used only by the key-less `/auth/me` route to look up the app's
 * `tokenGeneration` before the real signature verification (the verify is what
 * actually authenticates). NEVER trust this result on its own.
 */
export function peekTokenApplicationId(token: string): string | null {
  try {
    const decoded = jwt.decode(token);
    if (
      decoded &&
      typeof decoded === 'object' &&
      typeof (decoded as Record<string, unknown>).applicationId === 'string'
    ) {
      return (decoded as { applicationId: string }).applicationId;
    }
    return null;
  } catch {
    return null;
  }
}

export type EndUserTokenType = 'eu_access' | 'eu_mfa_challenge';

export interface EndUserClaims<TType extends EndUserTokenType = EndUserTokenType> {
  /** Token-type discriminator. */
  typ: TType;
  /** EndUser id. */
  sub: string;
  /** Application this token is bound to. */
  applicationId: string;
  /**
   * Impersonation marker. When present on an `eu_access` token, this
   * TenantUser id originated the session — the operator is acting as
   * the EndUser at `sub`. Lifetime is forced to 5 minutes regardless of
   * caller; refresh is disabled. Used by audit + by routes that want
   * to gate "operator-impersonating" actions differently from "real user".
   */
  imp?: string;
  /**
   * Token-generation counter, present on RS256-signed tokens only. RS256 keys
   * are deployment-wide (not derived from `Application.tokenGeneration`), so
   * the per-app session kill-switch is preserved by embedding the generation
   * as a claim — API-side verification rejects tokens whose `gen` doesn't
   * match the app's current counter. Offline (JWKS) verifiers can't see a
   * bump; the 15-minute access lifetime bounds that window.
   */
  gen?: number;
  /**
   * Active organization id. When present, the session is "acting as" this org:
   * read endpoints (e.g. GET /billing/entitlements) default the subject to it
   * instead of the personal pool. Set via POST /users/me/organizations/:id/switch
   * and persisted on the RefreshToken so it survives refresh. Membership is
   * always re-confirmed server-side — a stale `oid` never grants access.
   */
  oid?: string;
  iat: number;
  exp: number;
}

export type UserSessionClaims = EndUserClaims<'eu_access'>;
export type MfaChallengeClaims = EndUserClaims<'eu_mfa_challenge'>;

// Short access lifetime — paired with a 30-day refresh token.
const DEFAULT_ACCESS_LIFETIME_SECONDS = 15 * 60;
// MFA challenge is even shorter — enough to scan a code, not enough to be useful if leaked.
const DEFAULT_MFA_CHALLENGE_LIFETIME_SECONDS = 5 * 60;

export interface IssueOptions {
  /** Token lifetime in seconds. Defaults to 15 minutes for access; 5 for challenge. */
  lifetimeSeconds?: number;
  /** Active organization id → embedded as the `oid` claim (access tokens only). */
  activeOrganizationId?: string;
}

function signEndUserToken(
  typ: EndUserTokenType,
  endUserId: string,
  applicationId: string,
  tokenGeneration: number,
  lifetimeSeconds: number,
  activeOrganizationId?: string,
): { token: string; expiresAt: Date } {
  const token = jwt.sign(
    { typ, sub: endUserId, applicationId, ...(activeOrganizationId && { oid: activeOrganizationId }) },
    appSigningKey(applicationId, tokenGeneration),
    { expiresIn: lifetimeSeconds, algorithm: 'HS256' },
  );
  return { token, expiresAt: new Date(Date.now() + lifetimeSeconds * 1000) };
}

export function issueUserAccessToken(
  endUserId: string,
  applicationId: string,
  tokenGeneration: number,
  options: IssueOptions = {},
): { token: string; expiresAt: Date } {
  return signEndUserToken(
    'eu_access',
    endUserId,
    applicationId,
    tokenGeneration,
    options.lifetimeSeconds ?? DEFAULT_ACCESS_LIFETIME_SECONDS,
    options.activeOrganizationId,
  );
}

/**
 * RS256 variant of `issueUserAccessToken`. Signs with the deployment's RSA
 * key (`kid` in the header, so verifiers — ours and offline JWKS consumers —
 * can pick the right public key) and embeds the app's `tokenGeneration` as a
 * `gen` claim to preserve the per-app kill-switch (see `EndUserClaims.gen`).
 */
export function issueUserAccessTokenRS256(
  endUserId: string,
  applicationId: string,
  tokenGeneration: number,
  key: ActiveSigningKey,
  options: IssueOptions = {},
): { token: string; expiresAt: Date } {
  const lifetime = options.lifetimeSeconds ?? DEFAULT_ACCESS_LIFETIME_SECONDS;
  const token = jwt.sign(
    {
      typ: 'eu_access' as const,
      sub: endUserId,
      applicationId,
      gen: tokenGeneration,
      ...(options.activeOrganizationId && { oid: options.activeOrganizationId }),
    },
    key.privatePem,
    { expiresIn: lifetime, algorithm: 'RS256', keyid: key.kid },
  );
  return { token, expiresAt: new Date(Date.now() + lifetime * 1000) };
}

/**
 * Issue an end-user ACCESS token honouring the Application's
 * `authConfig.tokenAlg` (HS256 default; RS256 = JWKS-verifiable). The single
 * entry point session flows should use — sign-in, refresh, org-switch all
 * route through here so an app's opt-in applies uniformly.
 */
export async function issueUserAccessTokenForApp(
  application: Pick<Application, 'id' | 'tokenGeneration' | 'authConfig'>,
  endUserId: string,
  options: IssueOptions = {},
): Promise<{ token: string; expiresAt: Date }> {
  const { tokenAlg } = AuthConfigSchema.parse(application.authConfig);
  if (tokenAlg === 'RS256') {
    const key = await getActiveSigningKey();
    return issueUserAccessTokenRS256(
      endUserId,
      application.id,
      application.tokenGeneration,
      key,
      options,
    );
  }
  return issueUserAccessToken(endUserId, application.id, application.tokenGeneration, options);
}

export function issueMfaChallengeToken(
  endUserId: string,
  applicationId: string,
  tokenGeneration: number,
  options: IssueOptions = {},
): { token: string; expiresAt: Date } {
  return signEndUserToken(
    'eu_mfa_challenge',
    endUserId,
    applicationId,
    tokenGeneration,
    options.lifetimeSeconds ?? DEFAULT_MFA_CHALLENGE_LIFETIME_SECONDS,
  );
}

/**
 * MCP access token (issued by the per-app OAuth AS). Signed with the SAME
 * per-app derived key as session tokens, so the session kill-switch
 * (tokenGeneration bump) revokes live MCP tokens too. `aud` binds the token to
 * one MCP resource (the app's MCP URL) so it can't be replayed elsewhere;
 * `scope` carries the granted OAuth scopes.
 */
export interface McpAccessClaims {
  typ: 'mcp_access';
  sub: string; // endUserId
  applicationId: string;
  aud: string; // MCP resource URL
  scope: string;
  iat: number;
  exp: number;
}

const DEFAULT_MCP_ACCESS_LIFETIME_SECONDS = 60 * 60; // 1 hour; paired with a refresh token.

export function issueMcpAccessToken(args: {
  endUserId: string;
  applicationId: string;
  tokenGeneration: number;
  audience: string;
  scope: string;
  lifetimeSeconds?: number;
}): { token: string; expiresAt: Date } {
  const lifetime = args.lifetimeSeconds ?? DEFAULT_MCP_ACCESS_LIFETIME_SECONDS;
  const token = jwt.sign(
    { typ: 'mcp_access' as const, sub: args.endUserId, applicationId: args.applicationId, scope: args.scope },
    appSigningKey(args.applicationId, args.tokenGeneration),
    { expiresIn: lifetime, algorithm: 'HS256', audience: args.audience },
  );
  return { token, expiresAt: new Date(Date.now() + lifetime * 1000) };
}

/**
 * Verify an MCP access token. Requires the expected audience (the MCP resource
 * URL) to match — a token minted for app A's MCP resource won't verify against
 * app B's. Returns claims or null.
 */
export function verifyMcpAccessToken(
  token: string,
  applicationId: string,
  tokenGeneration: number,
  expectedAudience: string,
): McpAccessClaims | null {
  try {
    const decoded = jwt.verify(token, appSigningKey(applicationId, tokenGeneration), {
      algorithms: ['HS256'],
      audience: expectedAudience,
    });
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      (decoded as Record<string, unknown>).typ !== 'mcp_access' ||
      typeof (decoded as Record<string, unknown>).sub !== 'string' ||
      (decoded as Record<string, unknown>).applicationId !== applicationId
    ) {
      return null;
    }
    return decoded as unknown as McpAccessClaims;
  } catch {
    return null;
  }
}

const DEFAULT_IMPERSONATION_LIFETIME_SECONDS = 5 * 60;

/**
 * Mint an impersonation access token. Carries the same `eu_access` typ
 * as a real session token but with an extra `imp` claim recording the
 * operator user id. Lifetime is bounded to 5 minutes; no refresh token
 * is issued alongside (operators re-mint via /impersonate on demand).
 */
export function issueImpersonationToken(
  endUserId: string,
  applicationId: string,
  operatorUserId: string,
  tokenGeneration: number,
  options: IssueOptions = {},
): { token: string; expiresAt: Date } {
  const lifetime = options.lifetimeSeconds ?? DEFAULT_IMPERSONATION_LIFETIME_SECONDS;
  const token = jwt.sign(
    { typ: 'eu_access' as const, sub: endUserId, applicationId, imp: operatorUserId },
    appSigningKey(applicationId, tokenGeneration),
    { expiresIn: lifetime, algorithm: 'HS256' },
  );
  return { token, expiresAt: new Date(Date.now() + lifetime * 1000) };
}

function verifyEndUserToken<TType extends EndUserTokenType>(
  token: string,
  requiredType: TType,
  applicationId: string,
  tokenGeneration: number,
): EndUserClaims<TType> | null {
  try {
    const decoded = jwt.verify(token, appSigningKey(applicationId, tokenGeneration), {
      algorithms: ['HS256'],
    });
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      (decoded as Record<string, unknown>).typ !== requiredType ||
      typeof (decoded as Record<string, unknown>).sub !== 'string' ||
      typeof (decoded as Record<string, unknown>).applicationId !== 'string'
    ) {
      return null;
    }
    return decoded as unknown as EndUserClaims<TType>;
  } catch {
    return null;
  }
}

/**
 * Verify a presented end-user access token. Returns claims on success,
 * `null` on any failure (bad signature, expired, malformed, wrong typ).
 * Never throws — callers map `null` to a `RelipayError`.
 *
 * **Refuses non-access typ.** An MFA challenge token (`eu_mfa_challenge`)
 * presented here returns `null` — it must be exchanged via /auth/mfa-verify
 * first.
 */
export function verifyUserAccessToken(
  token: string,
  applicationId: string,
  tokenGeneration: number,
): UserSessionClaims | null {
  return verifyEndUserToken(token, 'eu_access', applicationId, tokenGeneration);
}

/**
 * Verify a presented end-user access token of EITHER algorithm, dispatching
 * on the token header — with a strict allowlist per path (the header is
 * attacker-controlled; it only ever selects between two fixed verifiers, it
 * never picks the key):
 *
 *   - `alg: "HS256"` → verified against the per-app derived secret, exactly
 *     as `verifyUserAccessToken` (algorithms pinned to HS256). Any `kid` the
 *     attacker puts in the header is ignored — HS256 never consults the JWKS,
 *     so an HS256 token "claiming" an RSA kid cannot trick the verifier into
 *     using a public key as an HMAC secret.
 *   - `alg: "RS256"` → requires a `kid` that maps to one of OUR published
 *     signing keys (`getPublicKeyByKid`, strict). Verified with that public
 *     key only (algorithms pinned to RS256), then the `gen` claim must match
 *     the app's current `tokenGeneration` (kill-switch parity with HS256's
 *     derived key).
 *   - anything else → null.
 *
 * Returns claims on success, null on any failure. Never throws.
 */
export async function verifyUserAccessTokenAnyAlg(
  token: string,
  applicationId: string,
  tokenGeneration: number,
): Promise<UserSessionClaims | null> {
  let header: { alg?: unknown; kid?: unknown } | undefined;
  try {
    header = jwt.decode(token, { complete: true })?.header;
  } catch {
    return null;
  }
  if (!header) return null;

  if (header.alg === 'HS256') {
    return verifyUserAccessToken(token, applicationId, tokenGeneration);
  }

  if (header.alg === 'RS256') {
    if (typeof header.kid !== 'string' || header.kid.length === 0) return null;
    const publicPem = await getPublicKeyByKid(header.kid);
    if (!publicPem) return null; // unknown kid — never verify against guessed keys
    try {
      const decoded = jwt.verify(token, publicPem, { algorithms: ['RS256'] });
      if (
        typeof decoded !== 'object' ||
        decoded === null ||
        (decoded as Record<string, unknown>).typ !== 'eu_access' ||
        typeof (decoded as Record<string, unknown>).sub !== 'string' ||
        (decoded as Record<string, unknown>).applicationId !== applicationId ||
        (decoded as Record<string, unknown>).gen !== tokenGeneration
      ) {
        return null;
      }
      return decoded as unknown as UserSessionClaims;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Verify a presented MFA challenge token. Used by /auth/mfa-verify to
 * exchange for a real session after the user passes TOTP/backup code.
 */
export function verifyMfaChallengeToken(
  token: string,
  applicationId: string,
  tokenGeneration: number,
): MfaChallengeClaims | null {
  return verifyEndUserToken(token, 'eu_mfa_challenge', applicationId, tokenGeneration);
}
