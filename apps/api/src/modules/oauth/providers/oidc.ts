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

import { decodeJwtPayload, emailFromClaims, fetchJsonWithTimeout } from './_oauth2-base.js';
import { assertSafeUrl } from '../../../lib/ssrf-guard.js';
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
      client_secret: input.config.clientSecret,
      redirect_uri: input.config.redirectUri,
    });
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
      throw new Error(`OIDC token exchange failed (${input.config.issuerUrl}): HTTP ${tokenRes.status}`);
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
