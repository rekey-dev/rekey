/**
 * The per-workspace switch for the operator MCP server.
 *
 * Two kill switches already existed: OPERATOR_MCP_ENABLED (deployment-wide,
 * the server does not mount) and `authConfig.mcpEnabled` (per Application,
 * the END-USER MCP server, a different thing). Neither let one workspace's
 * owner say "no agent acts as any of my operators". This one does.
 *
 * Pinned:
 *   - default on: nothing changes until an owner switches it off
 *   - off refuses an already-issued PAT at auth time, with a code that names
 *     the switch and the route that flips it
 *   - off refuses new OAuth consent for the workspace
 *   - on again restores the SAME credential, refused, never revoked
 *   - only OWNER/ADMIN can flip it; a MEMBER gets the role floor
 *   - the workspace read reports the current state
 *   - the OAuth path: an issued access token is refused while off; the
 *     refresh chain keeps rotating and what it mints is refused too; on again
 *     restores the rotated credential with no re-consent
 *   - flipping it is a security event
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createHash, randomBytes } from 'node:crypto';
import { waitForSecurityEvents } from './wait-for-security-events.js';

const REDIRECT = 'http://127.0.0.1:9798/callback';
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

describe('workspace operator-MCP switch', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  let currentIp = '10.95.0.1';
  function inject(opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: currentIp, ...opts } as never);
  }
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  async function world(): Promise<{ ownerToken: string; tenantId: string; pat: string; memberToken: string }> {
    currentIp = `10.95.${++n}.1`;
    const tag = `mcpsw-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `owner-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: 'Switch Co' },
    });
    expect(su.statusCode).toBe(201);
    const ownerToken = (su.json().data as { accessToken: string }).accessToken;
    const tenantId = (su.json().data as { activeTenantId: string }).activeTenantId;

    const pat = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: auth(ownerToken),
      payload: { name: 'agent', scopes: ['read'] },
    });
    expect(pat.statusCode).toBe(201);

    const invitee = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `member-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: 'Own Co' },
    });
    const inviteeToken = (invitee.json().data as { accessToken: string }).accessToken;
    const inv = await inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: auth(ownerToken),
      payload: { email: `member-${tag}@example.com`, role: 'MEMBER' },
    });
    const acc = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: auth(inviteeToken),
      payload: { token: (inv.json().data as { token: string }).token },
    });
    expect(acc.statusCode).toBe(200);
    return {
      ownerToken,
      tenantId,
      pat: (pat.json().data as { rawToken: string }).rawToken,
      memberToken: (acc.json().data as { accessToken: string }).accessToken,
    };
  }

  const setSwitch = (token: string, on: boolean) =>
    inject({ method: 'PATCH', url: '/api/v1/tenant/workspace', headers: auth(token), payload: { operatorMcpEnabled: on } });
  const list = (pat: string) =>
    inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: auth(pat),
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });

  it('is on by default, refuses an issued token when off, and restores it when on again', async () => {
    const w = await world();
    const ws = await inject({ method: 'GET', url: '/api/v1/tenant/workspace', headers: auth(w.ownerToken) });
    expect((ws.json().data as { operatorMcpEnabled: boolean }).operatorMcpEnabled).toBe(true);
    expect((await list(w.pat)).statusCode).toBe(200);

    const off = await setSwitch(w.ownerToken, false);
    expect(off.statusCode).toBe(200);
    expect((off.json().data as { operatorMcpEnabled: boolean }).operatorMcpEnabled).toBe(false);

    const refused = await list(w.pat);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('OPERATOR_MCP_DISABLED');
    expect(refused.json().error.fix).toContain('operatorMcpEnabled');

    // Refused, never revoked: the same PAT works the moment it is back on.
    expect((await setSwitch(w.ownerToken, true)).statusCode).toBe(200);
    expect((await list(w.pat)).statusCode).toBe(200);
  });

  it('refuses new OAuth consent for a switched-off workspace', async () => {
    const w = await world();
    await setSwitch(w.ownerToken, false);
    const reg = await inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/register',
      payload: { redirect_uris: [REDIRECT], client_name: 'switch-test' },
    });
    expect(reg.statusCode).toBe(201);
    const { challenge } = pkce();
    const grant = await inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/grant',
      headers: auth(w.ownerToken),
      payload: {
        client_id: (reg.json() as { client_id: string }).client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp:operator:read',
        state: 'st',
        tenant_id: w.tenantId,
        approve: true,
      },
    });
    expect(grant.statusCode).toBe(403);
    expect(grant.json().error.code).toBe('OPERATOR_MCP_DISABLED');
  });

  it('only OWNER/ADMIN may flip it; a member gets the role floor', async () => {
    const w = await world();
    const r = await setSwitch(w.memberToken, false);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
    // And nothing changed.
    expect((await list(w.pat)).statusCode).toBe(200);
  });

  it('OAuth: off refuses the access token, refresh keeps rotating, on again restores it', async () => {
    const w = await world();
    const reg = await inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/register',
      payload: { redirect_uris: [REDIRECT], client_name: 'switch-oauth' },
    });
    const clientId = (reg.json() as { client_id: string }).client_id;
    const { verifier, challenge } = pkce();
    const grant = await inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/grant',
      headers: auth(w.ownerToken),
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp:operator:read',
        state: 'st',
        tenant_id: w.tenantId,
        approve: true,
      },
    });
    expect(grant.statusCode).toBe(200);
    const code = new URL((grant.json() as { data: { redirect: string } }).data.redirect).searchParams.get('code');
    const tok = await inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/token',
      payload: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId },
    });
    expect(tok.statusCode).toBe(200);
    const first = tok.json() as { access_token: string; refresh_token: string };
    expect((await list(first.access_token)).statusCode).toBe(200);

    await setSwitch(w.ownerToken, false);
    const refused = await list(first.access_token);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('OPERATOR_MCP_DISABLED');

    // The refresh chain is not the switch's business: it rotates, and what
    // it mints is refused at auth like any other access token for the
    // workspace. Gating refresh would drop every agent's grant during an
    // incident and force a re-consent afterwards, which is revoking.
    const refreshed = await inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/token',
      payload: { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId },
    });
    expect(refreshed.statusCode).toBe(200);
    const second = refreshed.json() as { access_token: string };
    expect((await list(second.access_token)).statusCode).toBe(403);

    await setSwitch(w.ownerToken, true);
    expect((await list(second.access_token)).statusCode).toBe(200);
  });

  it('flipping the switch is a security event', async () => {
    const w = await world();
    await setSwitch(w.ownerToken, false);
    const [ev] = await waitForSecurityEvents({ tenantId: w.tenantId, type: 'workspace.operator_mcp_switched' });
    expect(ev).toBeDefined();
    expect(ev!.actorType).toBe('operator');
    expect(ev!.metadata).toMatchObject({ enabled: false });
  });

  it('rename still works on its own, and the body needs at least one field', async () => {
    const w = await world();
    const renamed = await inject({
      method: 'PATCH',
      url: '/api/v1/tenant/workspace',
      headers: auth(w.ownerToken),
      payload: { name: 'Renamed Co' },
    });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json().data as { name: string; operatorMcpEnabled: boolean })).toMatchObject({
      name: 'Renamed Co',
      operatorMcpEnabled: true,
    });
    const empty = await inject({ method: 'PATCH', url: '/api/v1/tenant/workspace', headers: auth(w.ownerToken), payload: {} });
    expect(empty.statusCode).toBe(400);
  });
});
