/**
 * Per-app MCP OAuth 2.1 authorization server — increment 1:
 * mcpEnabled gating, discovery metadata (RFC 8414 / 9728), and dynamic client
 * registration (RFC 7591). Domain tables truncate before each test, so each
 * case bootstraps its own operator + app.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
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

describe('MCP OAuth AS — discovery + DCR', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  async function makeApp(mcpEnabled: boolean): Promise<{ slug: string; operatorToken: string; appId: string }> {
    const slug = `mcp-${n++}-${Math.random().toString(36).slice(2, 7)}`;
    const operatorToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: 'pw-one-two-three', workspaceName: 'MCP Co' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'MCP App', slug },
      })
      .then((r) => (r.json().data as { id: string }).id);
    if (mcpEnabled) {
      const r = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/auth-config`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { mcpEnabled: true },
      });
      expect(r.statusCode).toBe(200);
    }
    return { slug, operatorToken, appId };
  }

  it('metadata 404s when MCP is disabled (default)', async () => {
    const { slug } = await makeApp(false);
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${slug}/.well-known/oauth-authorization-server`,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('MCP_NOT_FOUND');
  });

  it('authorization-server metadata (RFC 8414) when enabled', async () => {
    const { slug } = await makeApp(true);
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${slug}/.well-known/oauth-authorization-server`,
    });
    expect(r.statusCode).toBe(200);
    const md = r.json() as Record<string, unknown>;
    expect(md.issuer).toContain(`/api/v1/mcp/${slug}`);
    expect(md.authorization_endpoint).toContain('/oauth/authorize');
    expect(md.token_endpoint).toContain('/oauth/token');
    expect(md.registration_endpoint).toContain('/oauth/register');
    expect(md.code_challenge_methods_supported).toEqual(['S256']);
    expect(md.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  it('protected-resource metadata (RFC 9728) when enabled', async () => {
    const { slug } = await makeApp(true);
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${slug}/.well-known/oauth-protected-resource`,
    });
    expect(r.statusCode).toBe(200);
    const md = r.json() as { resource: string; authorization_servers: string[] };
    expect(md.resource).toContain(`/api/v1/mcp/${slug}`);
    expect(md.authorization_servers[0]).toContain(`/api/v1/mcp/${slug}`);
  });

  // ---- Root-level "path-insertion" discovery (RFC 8414 / 9728) ----
  // A strict connector (Claude custom connectors) constructs the metadata URL by
  // inserting the well-known segment right after the origin and re-appending the
  // issuer path: /.well-known/oauth-authorization-server/api/v1/mcp/<slug>.

  it('authorization-server metadata at the path-insertion URL is identical to the suffix form', async () => {
    const { slug } = await makeApp(true);
    const suffix = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${slug}/.well-known/oauth-authorization-server`,
    });
    const inserted = await app.inject({
      method: 'GET',
      url: `/.well-known/oauth-authorization-server/api/v1/mcp/${slug}`,
    });
    expect(inserted.statusCode).toBe(200);
    // Byte-identical body to the suffix form.
    expect(inserted.body).toBe(suffix.body);
    const md = inserted.json() as Record<string, unknown>;
    expect(md.issuer).toContain(`/api/v1/mcp/${slug}`);
    expect(md.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('protected-resource metadata at the path-insertion URL is identical to the suffix form', async () => {
    const { slug } = await makeApp(true);
    const suffix = await app.inject({
      method: 'GET',
      url: `/api/v1/mcp/${slug}/.well-known/oauth-protected-resource`,
    });
    const inserted = await app.inject({
      method: 'GET',
      url: `/.well-known/oauth-protected-resource/api/v1/mcp/${slug}`,
    });
    expect(inserted.statusCode).toBe(200);
    expect(inserted.body).toBe(suffix.body);
    const md = inserted.json() as { resource: string };
    expect(md.resource).toContain(`/api/v1/mcp/${slug}`);
  });

  it('path-insertion metadata 404s when MCP is disabled', async () => {
    const { slug } = await makeApp(false);
    const as = await app.inject({
      method: 'GET',
      url: `/.well-known/oauth-authorization-server/api/v1/mcp/${slug}`,
    });
    expect(as.statusCode).toBe(404);
    expect(as.json().error.code).toBe('MCP_NOT_FOUND');
    const pr = await app.inject({
      method: 'GET',
      url: `/.well-known/oauth-protected-resource/api/v1/mcp/${slug}`,
    });
    expect(pr.statusCode).toBe(404);
    expect(pr.json().error.code).toBe('MCP_NOT_FOUND');
  });

  it('dynamic client registration mints a public client (RFC 7591)', async () => {
    const { slug } = await makeApp(true);
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${slug}/oauth/register`,
      payload: { redirect_uris: ['http://localhost:9876/callback'], client_name: 'Claude Code' },
    });
    expect(r.statusCode).toBe(201);
    const c = r.json() as Record<string, unknown>;
    expect(typeof c.client_id).toBe('string');
    expect(c.token_endpoint_auth_method).toBe('none');
    expect(c.redirect_uris).toEqual(['http://localhost:9876/callback']);
    expect(c).not.toHaveProperty('client_secret');
  });

  it('DCR rejects an unacceptable redirect_uri', async () => {
    const { slug } = await makeApp(true);
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${slug}/oauth/register`,
      payload: { redirect_uris: ['ftp://nope'] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_REDIRECT_URI');
  });

  // ---- Full authorization-code + PKCE flow ----

  const REDIRECT = 'http://localhost:9876/cb';

  async function bootstrapFlow(): Promise<{
    slug: string;
    liveKey: string;
    euEmail: string;
    euPassword: string;
    clientId: string;
  }> {
    const { slug, operatorToken, appId } = await makeApp(true);
    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'mcp-key', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    const euEmail = `eu-${slug}@example.com`;
    const euPassword = 'pw-one-two-three';
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: euEmail, password: euPassword },
    });
    const clientId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/mcp/${slug}/oauth/register`,
        payload: { redirect_uris: [REDIRECT], client_name: 'Claude Code' },
      })
      .then((r) => (r.json() as { client_id: string }).client_id);
    return { slug, liveKey, euEmail, euPassword, clientId };
  }

  async function authorizeToCode(
    ctx: { slug: string; clientId: string; euEmail: string; euPassword: string },
    challenge: string,
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${ctx.slug}/oauth/authorize`,
      ...form({
        response_type: 'code',
        client_id: ctx.clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp:account',
        state: 'xyz',
        email: ctx.euEmail,
        password: ctx.euPassword,
        consent: 'allow',
      }),
    });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.searchParams.get('state')).toBe('xyz');
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();
    return code!;
  }

  it('authorization_code + PKCE flow yields a working access token (introspect active)', async () => {
    const ctx = await bootstrapFlow();
    const { verifier, challenge } = pkce();
    const code = await authorizeToCode(ctx, challenge);

    const tok = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${ctx.slug}/oauth/token`,
      ...form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: ctx.clientId,
      }),
    });
    expect(tok.statusCode).toBe(200);
    const body = tok.json() as { access_token: string; refresh_token: string; token_type: string };
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();

    // Introspect (app secret key) → active.
    const intro = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${ctx.slug}/oauth/introspect`,
      headers: {
        authorization: `Bearer ${ctx.liveKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ token: body.access_token }).toString(),
    });
    expect(intro.statusCode).toBe(200);
    // Token state must never be cached by an intermediary.
    expect(intro.headers['cache-control']).toBe('no-store');
    const ij = intro.json() as { active: boolean; scope: string };
    expect(ij.active).toBe(true);
    expect(ij.scope).toBe('mcp:account');

    // Refresh grant mints a new access token (client_id required + bound).
    const refreshed = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${ctx.slug}/oauth/token`,
      ...form({
        grant_type: 'refresh_token',
        refresh_token: body.refresh_token,
        client_id: ctx.clientId,
      }),
    });
    expect(refreshed.statusCode).toBe(200);
    expect((refreshed.json() as { access_token: string }).access_token).toBeTruthy();
  });

  it('authorize denies an end-user who must enroll MFA (required policy, not yet enrolled) — no code minted', async () => {
    const { slug, operatorToken, appId } = await makeApp(true);
    // App mandates MFA for end-users.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/auth-config`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { mfa: 'required' },
    });
    expect(patched.statusCode).toBe(200);
    // A live key to sign up an end-user who never enrolls a second factor.
    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'mcp-key', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    const euEmail = `eu-mfa-${slug}@example.com`;
    const euPassword = 'pw-one-two-three';
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: euEmail, password: euPassword },
    });
    const clientId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/mcp/${slug}/oauth/register`,
        payload: { redirect_uris: [REDIRECT], client_name: 'Claude Code' },
      })
      .then((r) => (r.json() as { client_id: string }).client_id);
    const { challenge } = pkce();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${slug}/oauth/authorize`,
      ...form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp:account',
        state: 'xyz',
        email: euEmail,
        password: euPassword,
        consent: 'allow',
      }),
    });
    // Re-renders the consent/login page (200 HTML) — NOT a 302 redirect with a
    // code. A token must never be issued without the mandated second factor.
    expect(res.statusCode).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).toContain('Two-factor authentication is required');
  });

  it('authorize rejects a redirect_uri not registered for the client (no open redirect)', async () => {
    const ctx = await bootstrapFlow();
    const { challenge } = pkce();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${ctx.slug}/oauth/authorize`,
      ...form({
        response_type: 'code',
        client_id: ctx.clientId,
        redirect_uri: 'http://localhost:9876/EVIL', // not the registered REDIRECT
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp:account',
        email: ctx.euEmail,
        password: ctx.euPassword,
        consent: 'allow',
      }),
    });
    expect(res.statusCode).toBe(400);
    // Never redirect to an unvalidated URI.
    expect(res.headers.location).toBeUndefined();
  });

  it('a session refresh token cannot be redeemed at the MCP token endpoint', async () => {
    const ctx = await bootstrapFlow();
    // Sign the end-user in via the SDK surface → a `session`-kind refresh token.
    const signin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${ctx.liveKey}` },
      payload: { email: ctx.euEmail, password: ctx.euPassword },
    });
    const sessionRefresh = (signin.json() as { refreshToken: string }).refreshToken;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${ctx.slug}/oauth/token`,
      ...form({
        grant_type: 'refresh_token',
        refresh_token: sessionRefresh,
        client_id: ctx.clientId,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('an MCP refresh token cannot be redeemed at the session /auth/refresh endpoint', async () => {
    const ctx = await bootstrapFlow();
    const { verifier, challenge } = pkce();
    const code = await authorizeToCode(ctx, challenge);
    const tok = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${ctx.slug}/oauth/token`,
      ...form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: ctx.clientId,
      }),
    });
    const mcpRefresh = (tok.json() as { refresh_token: string }).refresh_token;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${ctx.liveKey}` },
      payload: { refreshToken: mcpRefresh },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json().error as { code: string }).code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('token endpoint rejects a wrong PKCE verifier (invalid_grant)', async () => {
    const ctx = await bootstrapFlow();
    const { challenge } = pkce();
    const code = await authorizeToCode(ctx, challenge);
    const tok = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${ctx.slug}/oauth/token`,
      ...form({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'the-wrong-verifier',
        redirect_uri: REDIRECT,
        client_id: ctx.clientId,
      }),
    });
    expect(tok.statusCode).toBe(400);
    expect((tok.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('authorization code is single-use (replay → invalid_grant)', async () => {
    const ctx = await bootstrapFlow();
    const { verifier, challenge } = pkce();
    const code = await authorizeToCode(ctx, challenge);
    const exchange = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${ctx.slug}/oauth/token`,
        ...form({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
          client_id: ctx.clientId,
        }),
      });
    expect((await exchange()).statusCode).toBe(200);
    const replay = await exchange();
    expect(replay.statusCode).toBe(400);
    expect((replay.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('authorize denies with wrong credentials (re-renders, no code)', async () => {
    const ctx = await bootstrapFlow();
    const { challenge } = pkce();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${ctx.slug}/oauth/authorize`,
      ...form({
        response_type: 'code',
        client_id: ctx.clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        email: ctx.euEmail,
        password: 'wrong-password',
        consent: 'allow',
      }),
    });
    // Re-renders the form (200 HTML), does NOT redirect with a code.
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  // ---- MCP resource endpoint (JSON-RPC) ----

  async function accessTokenFor(ctx: {
    slug: string;
    clientId: string;
    euEmail: string;
    euPassword: string;
  }): Promise<string> {
    const { verifier, challenge } = pkce();
    const code = await authorizeToCode(ctx, challenge);
    const tok = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${ctx.slug}/oauth/token`,
      ...form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: ctx.clientId,
      }),
    });
    return (tok.json() as { access_token: string }).access_token;
  }

  function rpc(slug: string, token: string | null, msg: object): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    return app.inject({ method: 'POST', url: `/api/v1/mcp/${slug}`, headers, payload: JSON.stringify(msg) });
  }

  it('MCP endpoint requires a token (401 + WWW-Authenticate → resource metadata)', async () => {
    const ctx = await bootstrapFlow();
    const res = (await rpc(ctx.slug, null, { jsonrpc: '2.0', id: 1, method: 'initialize' })) as {
      statusCode: number;
      headers: Record<string, string>;
    };
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata');
    expect(res.headers['www-authenticate']).toContain('oauth-protected-resource');
  });

  it('MCP endpoint rejects a garbage token', async () => {
    const ctx = await bootstrapFlow();
    const res = (await rpc(ctx.slug, 'not-a-real-token', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    })) as { statusCode: number };
    expect(res.statusCode).toBe(401);
  });

  it('end-to-end: token → initialize, tools/list, tools/call get_profile', async () => {
    const ctx = await bootstrapFlow();
    const token = await accessTokenFor(ctx);

    const init = (await rpc(ctx.slug, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    })) as { statusCode: number; json: () => { result: { serverInfo: { name: string } } } };
    expect(init.statusCode).toBe(200);
    expect(init.json().result.serverInfo.name).toBe('relipay-account');

    const list = (await rpc(ctx.slug, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      statusCode: number;
      json: () => { result: { tools: Array<{ name: string }> } };
    };
    expect(list.statusCode).toBe(200);
    const names = list.json().result.tools.map((t) => t.name);
    expect(names).toContain('get_profile');
    expect(names).toContain('get_credits');

    const call = (await rpc(ctx.slug, token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_profile', arguments: {} },
    })) as { statusCode: number; json: () => { result: { content: Array<{ type: string; text: string }> } } };
    expect(call.statusCode).toBe(200);
    const profile = JSON.parse(call.json().result.content[0]!.text) as { email: string };
    expect(profile.email).toBe(ctx.euEmail);

    // get_credits returns a balance for the same user.
    const credits = (await rpc(ctx.slug, token, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_credits', arguments: {} },
    })) as { json: () => { result: { content: Array<{ text: string }> } } };
    const bal = JSON.parse(credits.json().result.content[0]!.text) as { balance: number };
    expect(typeof bal.balance).toBe('number');
  });

  it('MCP unknown tool returns a JSON-RPC error', async () => {
    const ctx = await bootstrapFlow();
    const token = await accessTokenFor(ctx);
    const res = (await rpc(ctx.slug, token, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'definitely_not_a_tool', arguments: {} },
    })) as { json: () => { error?: { code: number } } };
    expect(res.json().error?.code).toBe(-32602);
  });
});
