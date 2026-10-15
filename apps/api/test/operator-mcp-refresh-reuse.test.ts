/**
 * Replaying a rotated operator MCP refresh token revokes its whole family. On
 * a leak the attacker rotates first, so the replay is the legitimate client
 * arriving second and the token the attacker holds must die with it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Claude Desktop's real callback, a REMOTE https URL, not a loopback one. */
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

describe('operator MCP refresh token reuse', () => {
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
  it('replaying a rotated refresh token revokes the whole family', async () => {
    const { clientId, refreshToken: rt1 } = await connect('burn');

    // Legitimate rotation.
    const first = await refresh(clientId, rt1);
    expect(first.statusCode).toBe(200);
    const rt2 = (first.json() as { refresh_token: string }).refresh_token;

    // Replay the spent token, this is the compromise signal.
    const replay = await refresh(clientId, rt1);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_grant');

    // THE POINT: the live token the rotation produced must now be dead too.
    // Before the family burn this call returned 200, a thief who rotated
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

  it('an unknown refresh token burns nothing, no anonymous denial of service', async () => {
    const { clientId, refreshToken } = await connect('nodos');
    const bogus = await refresh(clientId, randomBytes(32).toString('base64url'));
    expect(bogus.statusCode).toBe(400);

    // The real chain is untouched: an attacker who can guess a client_id must
    // not be able to sign the operator out by posting garbage at the endpoint.
    const still = await refresh(clientId, refreshToken);
    expect(still.statusCode).toBe(200);
  });
});
