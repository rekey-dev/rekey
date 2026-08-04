/**
 * PKCE on the generic OIDC provider.
 *
 * Without this the provider could not talk to any issuer that requires PKCE —
 * which OAuth 2.1 mandates, which Okta/Auth0/Keycloak default to, and which
 * Rekey's OWN Applications enforce: their authorize schema requires
 * `code_challenge`, so "sign in with one of your own Applications" failed
 * before it left the authorize step.
 *
 * The decision is read off the issuer's discovery document rather than a config
 * flag, so these tests stub discovery two ways and assert the provider adapts:
 * an issuer advertising S256 gets a challenge and a verifier, one advertising
 * nothing gets neither.
 *
 * Note what a previous version of this feature shipped WITHOUT: any test that
 * exercised an authorize URL at all. It typechecked, its unit tests passed, and
 * the first real click would have been rejected by the authorization server.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { OidcProvider, __resetForTests } from '../src/modules/oauth/providers/oidc.js';

const ISSUER = 'https://issuer.test';

/** Minimal discovery document, with the two fields under test parameterised. */
function doc(extra: Record<string, unknown>) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    ...extra,
  };
}

function stubDiscovery(body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetForTests();
});

const config = {
  clientId: 'client-abc',
  clientSecret: '',
  redirectUri: 'https://panel.test/login/oauth/rekey/callback',
  issuerUrl: ISSUER,
};

describe('OidcProvider PKCE', () => {
  it('sends S256 challenge when the issuer advertises it', async () => {
    stubDiscovery(doc({ code_challenge_methods_supported: ['S256'] }));
    const verifier = 'a'.repeat(43);

    const url = await new OidcProvider().buildAuthUrlAsync({
      config,
      state: 'state-1',
      codeVerifier: verifier,
    });

    const q = new URL(url).searchParams;
    expect(q.get('code_challenge_method')).toBe('S256');
    // The challenge must be the hash, never the verifier — sending the verifier
    // in the redirect would hand an interceptor the very secret PKCE exists to
    // withhold.
    const expected = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    expect(q.get('code_challenge')).toBe(expected);
    expect(q.get('code_challenge')).not.toBe(verifier);
    expect(url).not.toContain(verifier);
  });

  it('sends no PKCE parameters to an issuer that does not advertise support', async () => {
    // An issuer that never asked for these must not receive them.
    stubDiscovery(doc({}));

    const url = await new OidcProvider().buildAuthUrlAsync({
      config,
      state: 'state-2',
      codeVerifier: 'b'.repeat(43),
    });

    const q = new URL(url).searchParams;
    expect(q.get('code_challenge')).toBeNull();
    expect(q.get('code_challenge_method')).toBeNull();
  });

  it('still sends the standard parameters alongside PKCE', async () => {
    // Guards against the PKCE insert displacing something — the regression that
    // would break every existing OIDC deployment.
    stubDiscovery(doc({ code_challenge_methods_supported: ['S256'] }));
    const url = await new OidcProvider().buildAuthUrlAsync({
      config,
      state: 'state-3',
      codeVerifier: 'c'.repeat(43),
    });
    const q = new URL(url).searchParams;
    expect(q.get('client_id')).toBe('client-abc');
    expect(q.get('redirect_uri')).toBe(config.redirectUri);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('state')).toBe('state-3');
    expect(q.get('scope')).toContain('openid');
  });

  it('omits PKCE when the caller supplied no verifier', async () => {
    stubDiscovery(doc({ code_challenge_methods_supported: ['S256'] }));
    const url = await new OidcProvider().buildAuthUrlAsync({ config, state: 'state-4' });
    expect(new URL(url).searchParams.get('code_challenge')).toBeNull();
  });
});
