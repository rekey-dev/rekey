/**
 * Per-Application OpenID Connect provider: discovery, ID Token, UserInfo.
 *
 * The grant itself (PKCE, single-use codes, redirect-URI binding) is covered by
 * mcp.test.ts — this file exercises the OIDC layer on top of it, and leans hard
 * on the negative cases: scope enforcement, cross-application isolation, and
 * the two token-substitution shapes (an ID Token used as an access token, and
 * an access token from another grant).
 *
 * Domain tables truncate before each test, so each case bootstraps its own
 * operator + app.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function form(payload: Record<string, string>): {
  headers: Record<string, string>;
  payload: string;
} {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(payload).toString(),
  };
}

function decodeJwt(token: string): Record<string, unknown> {
  return jwt.decode(token) as Record<string, unknown>;
}

const REDIRECT = 'http://localhost:9876/cb';
const EU_PASSWORD = 'pw-one-two-three';

describe('OIDC provider', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  let n = 0;

  interface Fixture {
    slug: string;
    appId: string;
    clientId: string;
    euEmail: string;
    euId: string;
    liveKey: string;
    operatorToken: string;
  }

  /**
   * An Application with the requested toggles, one registered public client and
   * one end-user carrying a display name under `metadata.oidc` (the reserved,
   * operator-only namespace the `profile` claims are read from — Rekey has no
   * name column).
   *
   * `requireEmailVerification` defaults ON here because the `email` scope is
   * not grantable without it, and most of this file is about claims. The
   * end-user is seeded through the OPERATOR route rather than public sign-up
   * for the same reason: with the gate on, `POST /auth/sign-up` deliberately
   * hands back no session, and `metadata.oidc` is not writable from a
   * browser-shipped credential anyway.
   */
  interface Toggles {
    oidcEnabled?: boolean;
    mcpEnabled?: boolean;
    requireEmailVerification?: boolean;
    dynamicClientRegistration?: boolean;
  }

  async function bootstrap(toggles: Toggles = {}): Promise<Fixture> {
    const slug = `oidc-${n++}-${Math.random().toString(36).slice(2, 7)}`;
    const operatorToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: EU_PASSWORD, workspaceName: 'OIDC Co' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'OIDC App', slug },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/auth-config`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { oidcEnabled: true, requireEmailVerification: true, ...toggles },
    });
    expect(patched.statusCode).toBe(200);
    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'oidc-key', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    const euEmail = `eu-${slug}@example.com`;
    const euId = await seedEndUser({ appId, operatorToken }, euEmail);
    const clientId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/mcp/${slug}/oauth/register`,
        payload: { redirect_uris: [REDIRECT], client_name: 'Some Relying Party' },
      })
      .then((r) => (r.json() as { client_id: string }).client_id);
    return { slug, appId, clientId, euEmail, euId, liveKey, operatorToken };
  }

  /**
   * Seed a verified end-user through the operator route. The metadata is the
   * shape the provider has to get right: one claim in the reserved namespace,
   * one same-named key OUTSIDE it that must never be mistaken for a claim, and
   * two of the customer app's own fields that must never reach a relying party.
   */
  async function seedEndUser(
    target: { appId: string; operatorToken: string },
    email: string,
  ): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${target.appId}/end-users`,
      headers: { authorization: `Bearer ${target.operatorToken}` },
      payload: {
        email,
        password: EU_PASSWORD,
        emailVerified: true,
        metadata: {
          oidc: { name: 'Ada Lovelace' },
          name: 'not a claim',
          internal_risk_score: 'high',
          ssn: '000-00-0000',
        },
      },
    });
    expect(created.statusCode).toBe(201);
    return (created.json().data as { id: string }).id;
  }

  /** Run the authorize form to a code, then redeem it. Returns the token response. */
  async function grant(
    fx: Fixture,
    opts: { scope: string; nonce?: string },
  ): Promise<Record<string, string>> {
    const { verifier, challenge } = pkce();
    const authorize = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/authorize`,
      ...form({
        response_type: 'code',
        client_id: fx.clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: opts.scope,
        ...(opts.nonce !== undefined && { nonce: opts.nonce }),
        state: 'xyz',
        email: fx.euEmail,
        password: EU_PASSWORD,
        consent: 'allow',
      }),
    });
    expect(authorize.statusCode).toBe(302);
    const code = new URL(authorize.headers.location as string).searchParams.get('code');
    expect(code).toBeTruthy();
    const tok = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/token`,
      ...form({
        grant_type: 'authorization_code',
        code: code!,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: fx.clientId,
      }),
    });
    expect(tok.statusCode).toBe(200);
    return tok.json() as Record<string, string>;
  }

  // ---- Discovery ----------------------------------------------------------

  it('openid-configuration 404s unless oidcEnabled (MCP alone is not enough)', async () => {
    const fx = await bootstrap({ mcpEnabled: true, oidcEnabled: false });
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${fx.slug}/.well-known/openid-configuration`,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('OIDC_NOT_FOUND');
  });

  it('publishes an OpenID Provider metadata document naming only implemented features', async () => {
    const fx = await bootstrap();
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${fx.slug}/.well-known/openid-configuration`,
    });
    expect(r.statusCode).toBe(200);
    const md = r.json() as Record<string, unknown>;
    // OIDC Discovery 1.0 §3 REQUIRED members.
    for (const required of [
      'issuer',
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
      'response_types_supported',
      'subject_types_supported',
      'id_token_signing_alg_values_supported',
    ]) {
      expect(md[required], required).toBeTruthy();
    }
    expect(md.issuer).toContain(`/api/v1/mcp/${fx.slug}`);
    expect(md.userinfo_endpoint).toBe(`${md.issuer as string}/oauth/userinfo`);
    expect(md.id_token_signing_alg_values_supported).toEqual(['RS256']);
    expect(md.code_challenge_methods_supported).toEqual(['S256']);
    expect(md.subject_types_supported).toEqual(['public']);
    // Unsupported features are advertised as unsupported, not omitted.
    expect(md.request_parameter_supported).toBe(false);
    expect(md.request_uri_parameter_supported).toBe(false);
    expect(md.claims_parameter_supported).toBe(false);
    // MCP is off on this fixture, so `mcp:account` must not appear.
    expect(md.scopes_supported).toEqual(['openid', 'profile', 'email']);
  });

  it('jwks_uri points at the deployment JWKS, which really serves the ID Token key', async () => {
    const fx = await bootstrap();
    const md = await app
      .inject({ method: 'GET', url: `/api/v1/mcp/${fx.slug}/.well-known/openid-configuration` })
      .then((r) => r.json() as { jwks_uri: string });
    expect(md.jwks_uri).toMatch(/\/\.well-known\/jwks\.json$/);
    const tokens = await grant(fx, { scope: 'openid' });
    const kid = (jwt.decode(tokens.id_token!, { complete: true })?.header as { kid?: string }).kid;
    const jwks = await app
      .inject({ method: 'GET', url: '/.well-known/jwks.json' })
      .then((r) => r.json() as { keys: Array<{ kid: string; alg: string }> });
    expect(jwks.keys.some((k) => k.kid === kid && k.alg === 'RS256')).toBe(true);
  });

  it('serves the same document at the RFC 8414 path-insertion URL', async () => {
    const fx = await bootstrap();
    const suffix = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${fx.slug}/.well-known/openid-configuration`,
    });
    const inserted = await app.inject({
      method: 'GET',
      url: `/.well-known/openid-configuration/api/v1/mcp/${fx.slug}`,
    });
    expect(inserted.statusCode).toBe(200);
    expect(inserted.body).toBe(suffix.body);
  });

  it('advertises openid alongside mcp:account when both surfaces are on', async () => {
    const fx = await bootstrap({ oidcEnabled: true, mcpEnabled: true });
    const md = await app
      .inject({ method: 'GET', url: `/api/v1/mcp/${fx.slug}/.well-known/oauth-authorization-server` })
      .then((r) => r.json() as { scopes_supported: string[] });
    expect(md.scopes_supported).toEqual(['openid', 'profile', 'email', 'mcp:account']);
  });

  it('mounts the grant endpoints for an OIDC-only app (no MCP required)', async () => {
    const fx = await bootstrap({ oidcEnabled: true, mcpEnabled: false });
    const authorize = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${fx.slug}/oauth/authorize?response_type=code&client_id=${fx.clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${pkce().challenge}&code_challenge_method=S256&scope=openid`,
    });
    expect(authorize.statusCode).toBe(200);
    expect(authorize.body).toContain('Confirm who you are');
    // …but the MCP resource server itself stays 404, because mcpEnabled is off.
    const mcp = await app.inject({ method: 'POST', url: `/api/v1/mcp/${fx.slug}` });
    expect(mcp.statusCode).toBe(404);
  });

  // ---- ID Token -----------------------------------------------------------

  it('issues an ID Token with correct standard claims, signed RS256 by the JWKS key', async () => {
    const fx = await bootstrap();
    const before = Math.floor(Date.now() / 1000);
    const tokens = await grant(fx, { scope: 'openid', nonce: 'n-0S6_WzA2Mj' });
    expect(tokens.id_token).toBeTruthy();

    const header = jwt.decode(tokens.id_token!, { complete: true })?.header as {
      alg: string;
      kid?: string;
    };
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBeTruthy();

    const claims = decodeJwt(tokens.id_token!);
    expect(claims.iss).toContain(`/api/v1/mcp/${fx.slug}`);
    expect(claims.sub).toBe(fx.euId);
    expect(claims.aud).toBe(fx.clientId);
    expect(claims.nonce).toBe('n-0S6_WzA2Mj');
    expect(claims.exp as number).toBeGreaterThan(claims.iat as number);
    expect(claims.auth_time as number).toBeGreaterThanOrEqual(before);
    // at_hash binds the ID Token to the access token issued with it.
    expect(claims.at_hash).toBeTruthy();

    // The signature verifies against the published JWKS and nothing else.
    const jwks = await app
      .inject({ method: 'GET', url: '/.well-known/jwks.json' })
      .then((r) => r.json() as { keys: Array<{ kid: string; n: string; e: string }> });
    const jwk = jwks.keys.find((k) => k.kid === header.kid)!;
    const publicKey = { key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' as const };
    const verified = jwt.verify(tokens.id_token!, publicKey, {
      algorithms: ['RS256'],
      audience: fx.clientId,
      issuer: claims.iss as string,
    }) as Record<string, unknown>;
    expect(verified.sub).toBe(fx.euId);
  });

  it('omits nonce entirely when the client did not send one', async () => {
    const fx = await bootstrap();
    const tokens = await grant(fx, { scope: 'openid' });
    expect(decodeJwt(tokens.id_token!)).not.toHaveProperty('nonce');
  });

  it('issues no ID Token when openid was not requested', async () => {
    const fx = await bootstrap({ oidcEnabled: true, mcpEnabled: true });
    const tokens = await grant(fx, { scope: 'mcp:account' });
    expect(tokens.scope).toBe('mcp:account');
    expect(tokens.id_token).toBeUndefined();
  });

  it('sub is stable across grants and differs per application for the same email', async () => {
    const fx = await bootstrap();
    const first = decodeJwt((await grant(fx, { scope: 'openid' })).id_token!);
    const second = decodeJwt((await grant(fx, { scope: 'openid' })).id_token!);
    expect(second.sub).toBe(first.sub);

    // A second Application with an end-user of the SAME email must not produce
    // the same subject identifier — EndUser rows are per-application.
    const other = await bootstrap();
    await seedEndUser(other, fx.euEmail);
    const otherTokens = await grant({ ...other, euEmail: fx.euEmail }, { scope: 'openid' });
    const otherClaims = decodeJwt(otherTokens.id_token!);
    expect(otherClaims.sub).not.toBe(first.sub);
    expect(otherClaims.iss).not.toBe(first.iss);
  });

  it('gates identity claims in the ID Token on the granted scopes', async () => {
    const fx = await bootstrap();
    const bare = decodeJwt((await grant(fx, { scope: 'openid' })).id_token!);
    expect(bare).not.toHaveProperty('email');
    expect(bare).not.toHaveProperty('name');

    const withEmail = decodeJwt((await grant(fx, { scope: 'openid email' })).id_token!);
    expect(withEmail.email).toBe(fx.euEmail);
    expect(withEmail.email_verified).toBe(true);
    expect(withEmail).not.toHaveProperty('name');

    const withProfile = decodeJwt((await grant(fx, { scope: 'openid profile' })).id_token!);
    expect(withProfile.name).toBe('Ada Lovelace');
    expect(withProfile).not.toHaveProperty('email');
  });

  it('drops unsupported and disabled scopes instead of granting them', async () => {
    // MCP is OFF here — a client asking for it must not receive it.
    const fx = await bootstrap({ oidcEnabled: true, mcpEnabled: false });
    const tokens = await grant(fx, { scope: 'openid email mcp:account admin superuser' });
    expect(tokens.scope).toBe('openid email');
  });

  it('refuses an authorization request whose scopes are all ungrantable', async () => {
    const fx = await bootstrap({ oidcEnabled: true, mcpEnabled: false });
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${fx.slug}/oauth/authorize?response_type=code&client_id=${fx.clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${pkce().challenge}&code_challenge_method=S256&scope=mcp:account&state=st`,
    });
    expect(r.statusCode).toBe(302);
    const loc = new URL(r.headers.location as string);
    expect(loc.searchParams.get('error')).toBe('invalid_scope');
    expect(loc.searchParams.get('state')).toBe('st');
  });

  it('refuses prompt=none, request and request_uri with their spec error codes', async () => {
    const fx = await bootstrap();
    const authorizeUrl = (extra: Record<string, string>): string => {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: fx.clientId,
        redirect_uri: REDIRECT,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        scope: 'openid',
        ...extra,
      });
      return `/api/v1/mcp/${fx.slug}/oauth/authorize?${params.toString()}`;
    };
    for (const [extra, expected] of [
      [{ prompt: 'none' }, 'login_required'],
      [{ prompt: 'consent none' }, 'login_required'],
      [{ request: 'ey.ey.ey' }, 'request_not_supported'],
      [{ request_uri: 'https://example.com/r' }, 'request_uri_not_supported'],
      [{ response_type: 'id_token token' }, 'unsupported_response_type'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
    ] as const) {
      const label = JSON.stringify(extra);
      const r = await app.inject({ method: 'GET', url: authorizeUrl(extra) });
      expect(r.statusCode, label).toBe(302);
      expect(new URL(r.headers.location as string).searchParams.get('error'), label).toBe(expected);
    }
  });

  it('does not issue an ID Token on the refresh grant, and never widens the scope', async () => {
    const fx = await bootstrap({ oidcEnabled: true, mcpEnabled: true });
    const tokens = await grant(fx, { scope: 'openid email' });
    const refreshed = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/token`,
      ...form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token!,
        client_id: fx.clientId,
      }),
    });
    expect(refreshed.statusCode).toBe(200);
    const body = refreshed.json() as Record<string, string>;
    expect(body.id_token).toBeUndefined();
    // The refreshed access token carries the ORIGINAL grant — not mcp:account.
    expect(body.scope).toBe('openid email');
  });

  // ---- UserInfo -----------------------------------------------------------

  it('returns scope-gated claims to a valid bearer token', async () => {
    const fx = await bootstrap();
    const tokens = await grant(fx, { scope: 'openid email profile' });
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const claims = r.json() as Record<string, unknown>;
    expect(claims.sub).toBe(fx.euId);
    expect(claims.email).toBe(fx.euEmail);
    expect(claims.email_verified).toBe(true);
    expect(claims.name).toBe('Ada Lovelace');
    expect(typeof claims.updated_at).toBe('number');
  });

  it('accepts POST as well as GET (OIDC Core §5.3.1)', async () => {
    const fx = await bootstrap();
    const tokens = await grant(fx, { scope: 'openid' });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { sub: string }).sub).toBe(fx.euId);
  });

  it('returns ONLY sub for a bare openid grant', async () => {
    const fx = await bootstrap();
    const tokens = await grant(fx, { scope: 'openid' });
    const claims = await app
      .inject({
        method: 'GET',
        url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })
      .then((r) => r.json() as Record<string, unknown>);
    expect(Object.keys(claims)).toEqual(['sub']);
  });

  it('does not leak profile claims to an email-only grant, or vice versa', async () => {
    const fx = await bootstrap();
    const emailOnly = await grant(fx, { scope: 'openid email' });
    const emailClaims = await app
      .inject({
        method: 'GET',
        url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
        headers: { authorization: `Bearer ${emailOnly.access_token}` },
      })
      .then((r) => r.json() as Record<string, unknown>);
    expect(emailClaims).not.toHaveProperty('name');
    expect(emailClaims).not.toHaveProperty('updated_at');

    const profileOnly = await grant(fx, { scope: 'openid profile' });
    const profileClaims = await app
      .inject({
        method: 'GET',
        url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
        headers: { authorization: `Bearer ${profileOnly.access_token}` },
      })
      .then((r) => r.json() as Record<string, unknown>);
    expect(profileClaims).not.toHaveProperty('email');
    expect(profileClaims).not.toHaveProperty('email_verified');
  });

  it('never passes non-standard metadata keys through as claims', async () => {
    // The fixture's end-user carries app-internal keys alongside the reserved
    // `oidc` namespace. `profile` must surface the standard claim names from
    // inside that namespace and nothing else — passing the blob through would
    // be the leak, and reading `name` from the TOP level (which is the app's
    // own field, and end-user-writable) would be the impersonation.
    const fx = await bootstrap();
    const tokens = await grant(fx, { scope: 'openid profile' });
    const claims = await app
      .inject({
        method: 'GET',
        url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })
      .then((r) => r.json() as Record<string, unknown>);
    expect(claims.name).toBe('Ada Lovelace');
    expect(claims).not.toHaveProperty('internal_risk_score');
    expect(claims).not.toHaveProperty('ssn');
    expect(claims).not.toHaveProperty('oidc');
    // Also true of the ID Token, which carries the same claim set.
    expect(decodeJwt(tokens.id_token!)).not.toHaveProperty('internal_risk_score');
  });

  it('rejects a token that was never granted openid with 403 insufficient_scope', async () => {
    const fx = await bootstrap({ oidcEnabled: true, mcpEnabled: true });
    const tokens = await grant(fx, { scope: 'mcp:account' });
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(r.statusCode).toBe(403);
    expect((r.json() as { error: string }).error).toBe('insufficient_scope');
    expect(r.headers['www-authenticate']).toContain('insufficient_scope');
  });

  it('rejects a missing or garbage bearer token with 401 + WWW-Authenticate', async () => {
    const fx = await bootstrap();
    const none = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
    });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toContain('Bearer');

    const garbage = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(garbage.statusCode).toBe(401);
    expect((garbage.json() as { error: string }).error).toBe('invalid_token');
  });

  it('rejects an access token issued by a DIFFERENT application (no cross-app claims)', async () => {
    const victim = await bootstrap();
    const attacker = await bootstrap();
    const stolen = await grant(attacker, { scope: 'openid email' });
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${victim.slug}/oauth/userinfo`,
      headers: { authorization: `Bearer ${stolen.access_token}` },
    });
    expect(r.statusCode).toBe(401);
    expect((r.json() as { error: string }).error).toBe('invalid_token');
  });

  it('rejects an ID Token presented as an access token (token substitution)', async () => {
    const fx = await bootstrap();
    const tokens = await grant(fx, { scope: 'openid email' });
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
      headers: { authorization: `Bearer ${tokens.id_token}` },
    });
    expect(r.statusCode).toBe(401);
    expect((r.json() as { error: string }).error).toBe('invalid_token');
  });

  it('stops honouring tokens after the application session kill-switch fires', async () => {
    const fx = await bootstrap();
    const tokens = await grant(fx, { scope: 'openid' });
    const rotated = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${fx.appId}/rotate-sessions`,
      headers: { authorization: `Bearer ${fx.operatorToken}` },
    });
    expect(rotated.statusCode).toBe(200);
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(r.statusCode).toBe(401);
  });

  // ---- Cross-surface isolation -------------------------------------------

  it('an OIDC-only access token cannot reach the MCP tools (insufficient_scope)', async () => {
    const fx = await bootstrap({ oidcEnabled: true, mcpEnabled: true });
    const tokens = await grant(fx, { scope: 'openid email' });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}`,
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.statusCode).toBe(403);
    expect((r.json() as { error: string }).error).toBe('insufficient_scope');
  });

  it('an mcp:account token still reaches the MCP tools', async () => {
    const fx = await bootstrap({ oidcEnabled: true, mcpEnabled: true });
    const tokens = await grant(fx, { scope: 'openid mcp:account' });
    expect(tokens.scope).toBe('openid mcp:account');
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}`,
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.statusCode).toBe(200);
  });
});
