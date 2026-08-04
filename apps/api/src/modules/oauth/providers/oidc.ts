/**
 * Generic OpenID Connect provider.
 *
 * Drives any standards-compliant OIDC issuer (Okta, Auth0, Keycloak, Authentik,
 * Azure AD single-tenant, self-hosted GitLab, Cognito, …) using
 * `${issuerUrl}/.well-known/openid-configuration` for endpoint discovery.
 *
 * Per-Application config supplies the issuerUrl alongside clientId/secret/redirectUri.
 * Discovered endpoints are cached in-memory per (issuerUrl) with a 24h TTL —
 * endpoint rotations are picked up within a day (or immediately on restart).
 */

import { createHash } from 'node:crypto';
import { decodeJwtPayload, emailFromClaims, fetchJsonWithTimeout } from './_oauth2-base.js';
import { assertSafeUrl } from '../../../lib/ssrf-guard.js';
import { RekeyError } from '../../../lib/error.js';
import type {
  BuildAuthUrlInput,
  ExchangeInput,
  OAuthIdentityResult,
  OAuthProvider,
} from './types.js';

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  issuer: string;
  /**
   * RFC 8414. When the issuer advertises S256 we send PKCE; when it says
   * nothing we do not. Reading the answer off discovery rather than making it
   * a config flag means an issuer that REQUIRES PKCE — OAuth 2.1 mandates it,
   * and Rekey's own Applications enforce it — works without anyone knowing to
   * tick a box, and one that has never heard of it is unaffected.
   */
  code_challenge_methods_supported?: string[];
  /**
   * `['none']` means the issuer authenticates public clients by PKCE alone and
   * has no notion of a client secret. Sending one anyway is at best ignored and
   * at worst a 401 — and demanding the operator invent one is worse than both.
   */
  token_endpoint_auth_methods_supported?: string[];
}

/**
 * RFC 7636 §4.2: BASE64URL(SHA256(ASCII(verifier))), unpadded. The verifier
 * itself never leaves this server until the exchange, so an attacker who
 * intercepts the redirect holds a code they cannot spend.
 */
function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Does this issuer accept — and therefore expect — PKCE with S256? */
function wantsPkce(doc: DiscoveryDoc): boolean {
  return (doc.code_challenge_methods_supported ?? []).includes('S256');
}

/**
 * A confidential client sends its secret; a public one has none to send.
 * Decided by the issuer's advertised auth methods, falling back to "send it if
 * we have one", which is how every pre-existing configuration behaved.
 */
function sendsClientSecret(doc: DiscoveryDoc, secret: string | undefined): boolean {
  if (!secret) return false;
  const methods = doc.token_endpoint_auth_methods_supported;
  if (!methods || methods.length === 0) return true;
  return methods.some((m) => m !== 'none');
}

const DEFAULT_SCOPES = ['openid', 'email', 'profile'];
// Discovery docs change rarely but DO change (issuer migrations, endpoint
// moves). A 24h TTL means a rotated endpoint is picked up within a day
// instead of requiring an API restart; expired entries are evicted on access.
const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const discoveryCache = new Map<string, { promise: Promise<DiscoveryDoc>; expiresAt: number }>();

/**
 * Forget every discovered issuer.
 *
 * Test-only. A 24h TTL makes this cache permanent for the life of the module:
 * the first test to point an Application at `https://issuer.test` pins that
 * issuer's document for every test that follows, including ones that stub a
 * different document at the same URL. Called from test/setup.ts's beforeEach.
 */
export function __resetForTests(): void {
  discoveryCache.clear();
}

async function discover(issuerUrl: string): Promise<DiscoveryDoc> {
  const url = issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const cached = discoveryCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (cached) discoveryCache.delete(url);
  const promise = (async (): Promise<DiscoveryDoc> => {
    // SSRF guard: `issuerUrl` is tenant-controlled (Application.oauthConfig).
    // Reject internal/loopback/metadata targets before fetching.
    await assertSafeUrl(url);
    const res = await fetchJsonWithTimeout(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
    });
    if (!res.ok) {
      throw new Error(`OIDC discovery failed for ${url}: HTTP ${res.status}`);
    }
    const data = (res.data ?? {}) as Partial<DiscoveryDoc>;
    if (!data.authorization_endpoint || !data.token_endpoint || !data.issuer) {
      throw new Error(`OIDC discovery doc at ${url} missing required fields`);
    }
    return data as DiscoveryDoc;
  })();
  discoveryCache.set(url, { promise, expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS });
  // Drop cache entry on failure so the next attempt can retry.
  promise.catch(() => discoveryCache.delete(url));
  return promise;
}

export class OidcProvider implements OAuthProvider {
  readonly name = 'oidc';

  // The auth URL build is async (needs discovery), but the OAuthProvider
  // interface declares it sync. We satisfy the contract by doing the discovery
  // *during exchange* and using a small server-side redirect for the auth step:
  // — actually, since we control the call sites, the interface admits async by
  // returning a Promise<string>. See type widening in the registry call.
  buildAuthUrl(input: BuildAuthUrlInput): string {
    if (!input.config.issuerUrl) {
      throw new Error('OIDC provider requires `issuerUrl` in the config.');
    }
    // Synchronous variant: fetch discovery and throw if it isn't already in
    // the cache. Callers should warm the cache (or accept the throw and retry
    // — discovery is fast). We swap to async via the registry helper below.
    throw new Error(
      'OidcProvider.buildAuthUrl is async — use buildAuthUrlAsync instead. ' +
      'The registry caller in oauth.service.ts is the chokepoint.',
    );
  }

  async buildAuthUrlAsync(input: BuildAuthUrlInput): Promise<string> {
    if (!input.config.issuerUrl) {
      throw new Error('OIDC provider requires `issuerUrl` in the config.');
    }
    const doc = await discover(input.config.issuerUrl);
    const params = new URLSearchParams({
      client_id: input.config.clientId,
      redirect_uri: input.config.redirectUri,
      response_type: 'code',
      scope: (input.scopes ?? DEFAULT_SCOPES).join(' '),
      state: input.state,
    });
    // Only when the issuer says it understands S256. An issuer that requires
    // PKCE rejects an authorize request without a challenge outright, and one
    // that has never heard of it must not receive parameters it did not ask
    // for — so the discovery document decides, not a config flag.
    if (input.codeVerifier && wantsPkce(doc)) {
      params.set('code_challenge', challengeFor(input.codeVerifier));
      params.set('code_challenge_method', 'S256');
    }
    return `${doc.authorization_endpoint}?${params.toString()}`;
  }

  async exchange(input: ExchangeInput): Promise<OAuthIdentityResult> {
    if (!input.config.issuerUrl) {
      throw new Error('OIDC provider requires `issuerUrl` in the config.');
    }
    const doc = await discover(input.config.issuerUrl);

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.config.clientId,
      redirect_uri: input.config.redirectUri,
    });
    // A public client has no secret and the issuer has no field for one.
    if (sendsClientSecret(doc, input.config.clientSecret)) {
      tokenBody.set('client_secret', input.config.clientSecret);
    }
    // Proves this exchange belongs to the browser that started the flow. For a
    // public client it IS the client authentication.
    if (input.codeVerifier && wantsPkce(doc)) {
      tokenBody.set('code_verifier', input.codeVerifier);
    }
    // Discovered endpoints are attacker-influenceable too (a malicious
    // discovery doc can point them anywhere) — validate before fetching.
    await assertSafeUrl(doc.token_endpoint);
    const tokenRes = await fetchJsonWithTimeout(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: tokenBody.toString(),
      redirect: 'error',
    });
    if (!tokenRes.ok) {
      // The authorization server says why in the body (RFC 6749 §5.2:
      // `invalid_grant`, `invalid_client`, …). Throwing a bare Error discarded
      // it and surfaced every failure as an opaque 500, which is useless to the
      // person stuck in the flow AND to the operator reading logs — the two
      // audiences who need it most.
      //
      // The upstream `error` code is safe to pass on: it is a fixed OAuth
      // vocabulary describing OUR request, not the user's data, and it is what
      // distinguishes "that code was already used" from "this client is
      // misconfigured". `error_description` is NOT forwarded — it is free text
      // from an operator-configured issuer.
      const body = (tokenRes.data ?? {}) as { error?: unknown; error_description?: unknown };
      const upstream = typeof body.error === 'string' ? body.error : null;
      throw new RekeyError({
        statusCode: 502,
        code: 'OAUTH_TOKEN_EXCHANGE_FAILED',
        message: upstream
          ? `The identity provider refused the token exchange (${upstream}).`
          : `The identity provider refused the token exchange (HTTP ${tokenRes.status}).`,
        fix:
          upstream === 'invalid_grant'
            ? 'The authorization code was already used, expired, or was issued for a different client or redirect URI. Start the sign-in again.'
            : 'Check the client id, redirect URI and issuer configured for this provider against what the identity provider expects.',
      });
    }
    const tokenData = (tokenRes.data ?? {}) as { id_token?: string; access_token?: string };

    if (tokenData.id_token) {
      const claims = decodeJwtPayload(tokenData.id_token);
      return {
        providerAccountId: String(claims['sub'] ?? ''),
        ...emailFromClaims(claims),
      };
    }

    if (doc.userinfo_endpoint && tokenData.access_token) {
      await assertSafeUrl(doc.userinfo_endpoint);
      const userRes = await fetchJsonWithTimeout(doc.userinfo_endpoint, {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/json',
        },
        redirect: 'error',
      });
      if (!userRes.ok) {
        throw new Error(`OIDC userinfo failed: HTTP ${userRes.status}`);
      }
      const data = (userRes.data ?? {}) as Record<string, unknown>;
      return {
        providerAccountId: String(data['sub'] ?? ''),
        ...emailFromClaims(data),
      };
    }

    throw new Error('OIDC: token response missing id_token and discovery has no userinfo_endpoint');
  }
}
