/**
 * Operator MCP OAuth — registration gating + refresh-token family revocation.
 *
 * Two findings from the 2.0.0 security close-out, both on the OPERATOR
 * authorization server (`/api/v1/tenant/mcp`), whose tokens are workspace-wide
 * admin credentials:
 *
 *   1. RFC 7591 dynamic client registration was unconditionally open, with no
 *      way for an operator to close it. The per-Application twin has had
 *      `authConfig.dynamicClientRegistration` since it was written; the
 *      operator surface had no equivalent. What an anonymous registration buys
 *      an attacker is an ALLOWLISTED redirect_uri they control — the one
 *      ingredient a consent-phishing link needs, since `/oauth/authorize`
 *      refuses any redirect_uri the client did not register.
 *
 *   2. Refresh-token reuse refused only the presented token. That is backwards:
 *      on a leak the ATTACKER rotates first, so the replay is the legitimate
 *      client arriving second — and the token the attacker rotated into stayed
 *      live. The end-user path has burned the whole family since
 *      `refresh.test.ts` ("revoking a reused refresh token kills the family");
 *      this surface was left as a seam.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Claude Desktop's real callback — a REMOTE https URL, not a loopback one. */
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

describe('Operator MCP OAuth hardening', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    delete process.env.OPERATOR_MCP_DYNAMIC_REGISTRATION;
  });

  async function makeOperator(slug: string): Promise<{ accessToken: string; tenantId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `mcph-${slug}@example.com`,
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

  /** Drive consent → code → token exchange, returning the first refresh token. */
  async function connect(slug: string): Promise<{ clientId: string; refreshToken: string }> {
    const op = await makeOperator(slug);
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
        tenant_id: op.tenantId,
        approve: true,
      },
    });
    expect(grant.statusCode).toBe(200);
    const code = new URL(
      (grant.json() as { data: { redirect: string } }).data.redirect,
    ).searchParams.get('code');

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
    return { clientId, refreshToken: (token.json() as { refresh_token: string }).refresh_token };
  }

  function refresh(clientId: string, refreshToken: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/token',
      payload: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId },
    });
  }

  // ---------- 1. Dynamic client registration is closeable ----------

  it('registration stays open by default — the documented client flow is unchanged', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/register',
      payload: { redirect_uris: [REDIRECT], client_name: 'Claude' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('advertises registration_endpoint while registration is open', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/mcp/.well-known/oauth-authorization-server',
    });
    expect(res.json()).toHaveProperty('registration_endpoint');
  });

  it('OPERATOR_MCP_DYNAMIC_REGISTRATION=disabled refuses anonymous registration', async () => {
    process.env.OPERATOR_MCP_DYNAMIC_REGISTRATION = 'disabled';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/register',
      payload: { redirect_uris: ['https://evil.example/cb'], client_name: 'Definitely Claude' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CLIENT_REGISTRATION_DISABLED');
  });

  it('drops registration_endpoint from RFC 8414 metadata when disabled', async () => {
    // A client that reads the document knows to ask the operator for a
    // client_id rather than retrying a 403 forever. Mirrors the per-app twin.
    process.env.OPERATOR_MCP_DYNAMIC_REGISTRATION = 'disabled';
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/mcp/.well-known/oauth-authorization-server',
    });
    expect(res.json()).not.toHaveProperty('registration_endpoint');
    // The rest of the document is unaffected — clients already holding a
    // client_id keep working.
    expect(res.json()).toHaveProperty('token_endpoint');
  });

  it('an unrecognised value falls back to the boot-validated mode, never to a typo', async () => {
    process.env.OPERATOR_MCP_DYNAMIC_REGISTRATION = 'disabeld';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/register',
      payload: { redirect_uris: [REDIRECT] },
    });
    expect(res.statusCode).toBe(201);
  });

  // ---------- 2. Refresh reuse burns the family ----------

  it('replaying a rotated refresh token revokes the whole family', async () => {
    const { clientId, refreshToken: rt1 } = await connect('burn');

    // Legitimate rotation.
    const first = await refresh(clientId, rt1);
    expect(first.statusCode).toBe(200);
    const rt2 = (first.json() as { refresh_token: string }).refresh_token;

    // Replay the spent token — this is the compromise signal.
    const replay = await refresh(clientId, rt1);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_grant');

    // THE POINT: the live token the rotation produced must now be dead too.
    // Before the family burn this call returned 200 — a thief who rotated
    // first kept a working workspace-admin credential for 30 days while the
    // real client got a single unexplained 400.
    const afterBurn = await refresh(clientId, rt2);
    expect(afterBurn.statusCode).toBe(400);
    expect(afterBurn.json().error).toBe('invalid_grant');
  });

  it('burns only the compromised family, not the operator\'s other connections', async () => {
    const a = await connect('burn-a');
    const b = await connect('burn-b');

    const rotated = await refresh(a.clientId, a.refreshToken);
    expect(rotated.statusCode).toBe(200);
    await refresh(a.clientId, a.refreshToken); // replay → burn family A

    // A different (tenantUser, tenant, client) triple is a different family.
    const unaffected = await refresh(b.clientId, b.refreshToken);
    expect(unaffected.statusCode).toBe(200);
  });

  it('an unknown refresh token burns nothing — no anonymous denial of service', async () => {
    const { clientId, refreshToken } = await connect('nodos');
    const bogus = await refresh(clientId, randomBytes(32).toString('base64url'));
    expect(bogus.statusCode).toBe(400);

    // The real chain is untouched: an attacker who can guess a client_id must
    // not be able to sign the operator out by posting garbage at the endpoint.
    const still = await refresh(clientId, refreshToken);
    expect(still.statusCode).toBe(200);
  });
});
