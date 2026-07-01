/**
 * Operator MCP OAuth — panel-IdP authorize + grant flow.
 *
 * The API no longer hosts a login form: GET /oauth/authorize validates the
 * client + PKCE and redirects to the panel's /mcp-consent. The panel, once the
 * operator has authenticated through the real panel login, calls the
 * session-authenticated POST /oauth/grant to mint the code.
 *
 * Load-bearing cases:
 *   - authorize redirects an authenticated-elsewhere browser to the panel;
 *   - authorize rejects an unknown client / unregistered redirect_uri;
 *   - grant requires an operator session (no anonymous code minting);
 *   - grant + PKCE round-trips to a working access token;
 *   - grant refuses a workspace the operator isn't a member of;
 *   - deny returns access_denied to the client redirect.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

describe('Operator MCP OAuth — panel-IdP authorize + grant', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function makeOperator(slug: string): Promise<{ accessToken: string; tenantId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `mcpg-${slug}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: `WS ${slug}`,
      },
    });
    const data = res.json().data as { accessToken: string; activeTenantId: string };
    return { accessToken: data.accessToken, tenantId: data.activeTenantId };
  }

  async function registerClient(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/register',
      payload: { redirect_uris: [REDIRECT], client_name: 'Claude' },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { client_id: string }).client_id;
  }

  it('authorize redirects to the panel consent page for a valid client', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/mcp/oauth/authorize`,
      query: {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp:operator:read',
        state: 'xyz',
      },
    });
    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain('/mcp-consent');
    expect(loc).toContain(`client_id=${clientId}`);
    expect(loc).toContain('state=xyz');
  });

  it('authorize rejects an unknown client / unregistered redirect_uri', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/mcp/oauth/authorize`,
      query: {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://evil.example/callback',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('grant requires an operator session (401 without bearer)', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/grant',
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        tenant_id: 't_whatever',
        approve: true,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('grant + PKCE round-trips to a working access token', async () => {
    const op = await makeOperator('rt');
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();

    const grant = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/grant',
      headers: { authorization: `Bearer ${op.accessToken}` },
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp:operator:read mcp:operator:write',
        state: 'st',
        tenant_id: op.tenantId,
        approve: true,
      },
    });
    expect(grant.statusCode).toBe(200);
    const redirect = (grant.json() as { data: { redirect: string } }).data.redirect;
    expect(redirect.startsWith(REDIRECT)).toBe(true);
    const code = new URL(redirect).searchParams.get('code');
    expect(code).toBeTruthy();
    expect(new URL(redirect).searchParams.get('state')).toBe('st');

    // Exchange the code for tokens.
    const token = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: clientId,
      },
    });
    expect(token.statusCode).toBe(200);
    const tok = token.json() as { access_token: string; scope: string };
    expect(typeof tok.access_token).toBe('string');
    expect(tok.scope).toContain('mcp:operator:write');

    // The access token actually authenticates the MCP endpoint.
    const mcp = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: { authorization: `Bearer ${tok.access_token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(mcp.statusCode).toBe(200);
    // write scope + OWNER (sign-up makes OWNER) → write tools are visible.
    const names = (mcp.json().result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('create_application');
  });

  it("grant refuses a workspace the operator isn't a member of (403)", async () => {
    const attacker = await makeOperator('attacker');
    const victim = await makeOperator('victim');
    const clientId = await registerClient();
    const { challenge } = pkce();

    const grant = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/grant',
      headers: { authorization: `Bearer ${attacker.accessToken}` },
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        tenant_id: victim.tenantId, // not the attacker's workspace
        approve: true,
      },
    });
    expect(grant.statusCode).toBe(403);
  });

  it('deny returns access_denied to the client redirect', async () => {
    const op = await makeOperator('deny');
    const clientId = await registerClient();
    const { challenge } = pkce();

    const grant = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/grant',
      headers: { authorization: `Bearer ${op.accessToken}` },
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'dn',
        tenant_id: op.tenantId,
        approve: false,
      },
    });
    expect(grant.statusCode).toBe(200);
    const redirect = (grant.json() as { data: { redirect: string } }).data.redirect;
    expect(new URL(redirect).searchParams.get('error')).toBe('access_denied');
    expect(new URL(redirect).searchParams.get('state')).toBe('dn');
  });
});
