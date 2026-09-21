/**
 * What the OIDC provider is willing to call an identity.
 *
 * The token comes back over TLS from the issuer's own token endpoint in
 * exchange for our code, so its signature is not re-checked here. What IS
 * checked is that the claims bind it to this exchange, and the reason is
 * blunt: `providerAccountId` is the key an account is created and later found
 * under, so a token with no `sub` used to produce the account id `''` and fold
 * every user of that provider onto one account. The other checks exist so a
 * document or a token from somewhere else cannot supply that id at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OidcProvider, __resetForTests } from '../src/modules/oauth/providers/oidc.js';

const ISSUER = 'https://issuer.test';
const CLIENT_ID = 'client-abc';

const config = {
  clientId: CLIENT_ID,
  clientSecret: 'shh',
  redirectUri: 'https://panel.test/login/oauth/rekey/callback',
  issuerUrl: ISSUER,
};

/** An unsigned JWT: the provider reads the payload and does not verify it. */
function idToken(claims: Record<string, unknown>): string {
  const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.signature`;
}

function validClaims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'user-1',
    iss: ISSUER,
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    email: 'someone@issuer.test',
    ...extra,
  };
}

function discoveryDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    ...extra,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Routes the three calls an exchange makes: discovery, token, userinfo. */
function stubIssuer(parts: {
  doc?: Record<string, unknown>;
  token?: Record<string, unknown>;
  userinfo?: Record<string, unknown>;
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/.well-known/openid-configuration')) return json(parts.doc ?? discoveryDoc());
      if (url.endsWith('/token')) return json(parts.token ?? {});
      if (url.endsWith('/userinfo')) return json(parts.userinfo ?? {});
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

const exchange = (): Promise<{ providerAccountId: string; email?: string }> =>
  new OidcProvider().exchange({ config, code: 'auth-code' }) as Promise<{
    providerAccountId: string;
    email?: string;
  }>;

afterEach(() => {
  vi.unstubAllGlobals();
  __resetForTests();
});

describe('OIDC identity claims', () => {
  it('accepts a token whose claims bind it to this issuer and client', async () => {
    stubIssuer({ token: { id_token: idToken(validClaims()) } });

    const identity = await exchange();

    expect(identity.providerAccountId).toBe('user-1');
    expect(identity.email).toBe('someone@issuer.test');
  });

  it('refuses a token with no subject rather than creating the account `\'\'`', async () => {
    stubIssuer({ token: { id_token: idToken({ ...validClaims(), sub: undefined }) } });

    await expect(exchange()).rejects.toMatchObject({ code: 'OAUTH_ID_TOKEN_INVALID' });
  });

  it('refuses a token issued by someone other than the configured issuer', async () => {
    stubIssuer({ token: { id_token: idToken(validClaims({ iss: 'https://elsewhere.test' })) } });

    await expect(exchange()).rejects.toMatchObject({ code: 'OAUTH_ID_TOKEN_INVALID' });
  });

  it('refuses a token minted for a different client', async () => {
    stubIssuer({ token: { id_token: idToken(validClaims({ aud: 'someone-elses-client' })) } });

    await expect(exchange()).rejects.toMatchObject({ code: 'OAUTH_ID_TOKEN_INVALID' });
  });

  it('refuses a multi-audience token whose `azp` names another party', async () => {
    // With more than one audience the token is usable elsewhere, so `azp` is
    // what says which client it was actually minted for (OIDC Core 3.1.3.7).
    stubIssuer({
      token: { id_token: idToken(validClaims({ aud: [CLIENT_ID, 'other'], azp: 'other' })) },
    });

    await expect(exchange()).rejects.toMatchObject({ code: 'OAUTH_ID_TOKEN_INVALID' });
  });

  it('accepts a multi-audience token authorized for this client', async () => {
    stubIssuer({
      token: { id_token: idToken(validClaims({ aud: [CLIENT_ID, 'other'], azp: CLIENT_ID })) },
    });

    await expect(exchange()).resolves.toMatchObject({ providerAccountId: 'user-1' });
  });

  it('refuses an expired token', async () => {
    stubIssuer({
      token: { id_token: idToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 600 })) },
    });

    await expect(exchange()).rejects.toMatchObject({ code: 'OAUTH_ID_TOKEN_INVALID' });
  });

  it('accepts a token that expired seconds ago, because our clock is not the issuer\'s', async () => {
    stubIssuer({
      token: { id_token: idToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 5 })) },
    });

    await expect(exchange()).resolves.toMatchObject({ providerAccountId: 'user-1' });
  });

  it('accepts an `exp` the issuer serialized as a string', async () => {
    stubIssuer({
      token: { id_token: idToken(validClaims({ exp: String(Math.floor(Date.now() / 1000) + 300) })) },
    });

    await expect(exchange()).resolves.toMatchObject({ providerAccountId: 'user-1' });
  });

  it('resolves a `{tenantid}` issuer template against the token, so a multi-tenant issuer still pins', async () => {
    // Microsoft's `common` endpoint answers discovery with the template and
    // the token carries the real tenant. Matching them is what keeps the
    // configuration working without accepting an arbitrary issuer.
    const template = 'https://login.microsoftonline.test/{tenantid}/v2.0';
    const issuerUrl = 'https://login.microsoftonline.test/common/v2.0';
    const tenant = '11111111-2222-3333-4444-555555555555';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/.well-known/openid-configuration')) {
          return json({
            issuer: template,
            authorization_endpoint: 'https://login.microsoftonline.test/common/authorize',
            token_endpoint: 'https://login.microsoftonline.test/common/token',
          });
        }
        return json({
          id_token: idToken({
            sub: 'aad-user',
            iss: `https://login.microsoftonline.test/${tenant}/v2.0`,
            tid: tenant,
            aud: CLIENT_ID,
            exp: Math.floor(Date.now() / 1000) + 300,
          }),
        });
      }),
    );

    const identity = await new OidcProvider().exchange({
      config: { ...config, issuerUrl },
      code: 'auth-code',
    });

    expect(identity.providerAccountId).toBe('aad-user');
  });

  it('refuses a discovery document that names an issuer we did not configure', async () => {
    // Otherwise the ID token check is self-referential: it compares the token
    // against a value the same document supplied.
    stubIssuer({
      doc: discoveryDoc({ issuer: 'https://elsewhere.test' }),
      token: { id_token: idToken(validClaims({ iss: 'https://elsewhere.test' })) },
    });

    await expect(exchange()).rejects.toThrow(/not by the configured issuer/);
  });

  it('refuses a userinfo response with no subject, the same hole on the other path', async () => {
    // Reached whenever the token response carries no id_token.
    stubIssuer({
      token: { access_token: 'at-1' },
      userinfo: { email: 'someone@issuer.test' },
    });

    await expect(exchange()).rejects.toMatchObject({ code: 'OAUTH_ID_TOKEN_INVALID' });
  });

  it('accepts a userinfo response that does carry a subject', async () => {
    stubIssuer({
      token: { access_token: 'at-1' },
      userinfo: { sub: 'user-2', email: 'someone@issuer.test' },
    });

    await expect(exchange()).resolves.toMatchObject({ providerAccountId: 'user-2' });
  });
});
