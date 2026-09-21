/**
 * Scopes reach the operator MCP server.
 *
 * The REST gate reads each route's `config.access`; tools have no route, so
 * they declare in `TOOL_SCOPES` and `toolAllowed` consults it before the
 * role and token checks. What is pinned:
 *
 *   - a tool the membership does not admit is neither listed nor callable,
 *     and the refusal names the scope
 *   - a tool it does admit still works, through the same token
 *   - the one aggregate that carries money omits the amounts without
 *     billing:read, omitted, never zeroed
 *   - every tool is either scoped or an explicit workspace floor, so a new
 *     tool cannot ship ungoverned (the MCP twin of route completeness)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { TOOL_SCOPES, WORKSPACE_TOOLS } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import { operatorTools } from '../src/modules/tenant-mcp/operator-tools.js';
import { operatorWriteTools } from '../src/modules/tenant-mcp/operator-write-tools.js';
import { isScope } from '../src/lib/operator-scopes.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';
import { createHash, randomBytes } from 'node:crypto';

/** A loopback redirect the AS accepts for a native client. */
const REDIRECT = 'http://127.0.0.1:9797/callback';

/** PKCE S256 pair. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('operator scopes over MCP', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  let currentIp = '10.96.0.1';
  function inject(opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: currentIp, ...opts } as never);
  }
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  /** Owner + app + a MEMBER holding APP_ADMIN, plus a PAT minted BY the member. */
  async function world(): Promise<{ ownerToken: string; membershipId: string; appId: string; pat: string; tenantId: string }> {
    currentIp = `10.96.${++n}.1`;
    const tag = `mcp-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `owner-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: 'MCP Co' },
    });
    expect(su.statusCode).toBe(201);
    const ownerToken = (su.json().data as { accessToken: string }).accessToken;

    const mk = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: auth(ownerToken),
      payload: { name: tag, slug: tag },
    });
    expect(mk.statusCode).toBe(201);
    const appId = (mk.json().data as { id: string }).id;

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
    const token = (inv.json().data as { token: string }).token;
    const acc = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: auth(inviteeToken),
      payload: { token },
    });
    expect(acc.statusCode).toBe(200);
    const memberToken = (acc.json().data as { accessToken: string }).accessToken;

    const members = await inject({ method: 'GET', url: '/api/v1/tenant/workspace/members', headers: auth(ownerToken) });
    const membershipId = (members.json().data as { items: Array<{ membershipId: string; role: string }> }).items.find(
      (m) => m.role === 'MEMBER',
    )!.membershipId;
    const g = await inject({
      method: 'PUT',
      url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
      headers: auth(ownerToken),
      payload: { applicationId: appId, role: 'APP_ADMIN' },
    });
    expect(g.statusCode).toBe(200);

    // A MEMBER cannot mint a personal access token (that route is an
    // OWNER/ADMIN floor), so the only way a member reaches MCP is the OAuth
    // consent flow. Drive it: register a client, grant with the member's
    // session, exchange the code. Full token authority (read + write), so
    // anything refused below is the MEMBERSHIP's scopes, not the token's.
    const me = await inject({ method: 'GET', url: '/api/v1/tenant/auth/me', headers: auth(memberToken) });
    const tenantId = (me.json().data as { activeTenantId: string }).activeTenantId;
    const reg = await inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/register',
      payload: { redirect_uris: [REDIRECT], client_name: 'scopes-test' },
    });
    expect(reg.statusCode).toBe(201);
    const clientId = (reg.json() as { client_id: string }).client_id;
    const { verifier, challenge } = pkce();
    const grant = await inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/grant',
      headers: auth(memberToken),
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp:operator:read mcp:operator:write',
        state: 'st',
        tenant_id: tenantId,
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
    return { ownerToken, membershipId, appId, tenantId, pat: (tok.json() as { access_token: string }).access_token };
  }

  const setScopes = (w: { ownerToken: string; membershipId: string }, scopes: string[] | null) =>
    inject({
      method: 'PATCH',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
      headers: auth(w.ownerToken),
      payload: { scopes },
    });

  async function rpc(token: string, method: string, params?: Record<string, unknown>) {
    const r = await inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: auth(token),
      payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    });
    return r.json() as { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } };
  }
  const called = (res: Awaited<ReturnType<typeof rpc>>) => JSON.parse(res.result!.content![0]!.text) as Record<string, unknown>;

  it('a tool the membership does not admit is neither listed nor callable', async () => {
    const w = await world();
    await setScopes(w, ['end-users:write', 'organizations:read']);

    const listed = (await rpc(w.pat, 'tools/list')).result!.tools!.map((t) => t.name);
    expect(listed).toContain('list_devices');
    expect(listed).toContain('list_organization_roles');
    expect(listed).not.toContain('list_plans');
    expect(listed).not.toContain('recent_payments');

    const refused = await rpc(w.pat, 'tools/call', { name: 'list_plans', arguments: { applicationId: w.appId } });
    expect(refused.result!.isError).toBe(true);
    expect(called(refused).error).toContain('billing:read');

    // A tool the scopes admit runs, through the same token that was just
    // refused above, so the refusal was the membership, not the credential.
    const ok = await rpc(w.pat, 'tools/call', { name: 'list_organization_roles', arguments: { applicationId: w.appId } });
    expect(ok.result!.isError).toBeUndefined();
  });

  it('the workspace overview omits the money without billing:read, and includes it with', async () => {
    const w = await world();
    await setScopes(w, ['overview:read', 'end-users:read']);
    const without = called(await rpc(w.pat, 'tools/call', { name: 'get_workspace_overview', arguments: {} }));
    expect(without).toHaveProperty('activeSubscriptions');
    expect(without).not.toHaveProperty('mrrMinor');
    expect(without).not.toHaveProperty('currencies');

    await setScopes(w, ['overview:read', 'billing:read']);
    const withBilling = called(await rpc(w.pat, 'tools/call', { name: 'get_workspace_overview', arguments: {} }));
    expect(withBilling).toHaveProperty('mrrMinor');
  });

  it('every tool is either scoped or an explicit workspace floor', () => {
    const all = [...operatorTools, ...operatorWriteTools].map((t) => t.name);
    const ungoverned = all.filter((name) => TOOL_SCOPES[name] === undefined && !WORKSPACE_TOOLS.has(name));
    expect(ungoverned, 'a tool is neither in TOOL_SCOPES nor WORKSPACE_TOOLS').toEqual([]);
    // And nothing in either table names a tool that no longer exists.
    const known = new Set(all);
    expect([...Object.keys(TOOL_SCOPES), ...WORKSPACE_TOOLS].filter((n) => !known.has(n))).toEqual([]);
    for (const s of Object.values(TOOL_SCOPES)) expect(isScope(s)).toBe(true);
    // And the two tables are disjoint: a tool is scoped or a floor, not both.
    expect(Object.keys(TOOL_SCOPES).filter((n) => WORKSPACE_TOOLS.has(n))).toEqual([]);
  });

  it('promotion clears scopes: a restricted member made ADMIN holds every tool', async () => {
    const w = await world();
    await setScopes(w, ['organizations:read']);
    expect((await rpc(w.pat, 'tools/list')).result!.tools!.map((t) => t.name)).not.toContain('list_plans');

    const promoted = await inject({
      method: 'PATCH',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
      headers: auth(w.ownerToken),
      payload: { role: 'ADMIN' },
    });
    expect(promoted.statusCode).toBe(200);
    // The row is cleared, not merely hidden: the roster (which shows stored
    // scopes) reports none.
    expect((promoted.json().data as { scopes: string[] | null }).scopes).toBeNull();
    const roster = await inject({ method: 'GET', url: '/api/v1/tenant/workspace/members', headers: auth(w.ownerToken) });
    const row = (roster.json().data as { items: Array<{ membershipId: string; scopes: string[] | null }> }).items.find(
      (m) => m.membershipId === w.membershipId,
    )!;
    expect(row.scopes).toBeNull();
    // Same token, now an admin: the tool it was refused a moment ago is listed and runs.
    expect((await rpc(w.pat, 'tools/list')).result!.tools!.map((t) => t.name)).toContain('list_plans');
    const ok = await rpc(w.pat, 'tools/call', { name: 'list_plans', arguments: { applicationId: w.appId } });
    expect(ok.result!.isError).toBeUndefined();
    // No gate checked an admin, so the event records no admitting scope.
    const evs = await waitForSecurityEvents({ tenantId: w.tenantId, type: 'operator.mcp_tool_called' });
    const adminCall = evs.find((e) => (e.metadata as { tool: string }).tool === 'list_plans');
    expect(adminCall?.metadata).toMatchObject({ tool: 'list_plans', scope: null });

    // Demoted again: starts unrestricted (the row was cleared), so the admin
    // restricts afresh rather than inheriting a restriction they cannot see.
    const demoted = await inject({
      method: 'PATCH',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
      headers: auth(w.ownerToken),
      payload: { role: 'MEMBER' },
    });
    expect(demoted.statusCode).toBe(200);
    expect((demoted.json().data as { scopes: string[] | null }).scopes).toBeNull();
    expect((await rpc(w.pat, 'tools/list')).result!.tools!.map((t) => t.name)).toContain('list_plans');
  });

  it('the tool-call security event records the admitting scope', async () => {
    const w = await world();
    await setScopes(w, ['organizations:read']);
    const ok = await rpc(w.pat, 'tools/call', { name: 'list_organization_roles', arguments: { applicationId: w.appId } });
    expect(ok.result!.isError).toBeUndefined();
    const [ev] = await waitForSecurityEvents({ tenantId: w.tenantId, type: 'operator.mcp_tool_called' });
    expect(ev).toBeDefined();
    expect(ev!.metadata).toMatchObject({ tool: 'list_organization_roles', scope: 'organizations:read' });
  });

  it('per-app counts are overview data: omitted without overview:read, present with it', async () => {
    const w = await world();
    const listApps = async () => {
      const apps = called(await rpc(w.pat, 'tools/call', { name: 'list_applications', arguments: {} })) as unknown as {
        applications: Array<Record<string, unknown>>;
      };
      return apps.applications.find((a) => a.id === w.appId)!;
    };
    await setScopes(w, ['end-users:read']);
    const without = await listApps();
    expect(without).toHaveProperty('slug');
    expect(without).not.toHaveProperty('endUserCount');
    expect(without).not.toHaveProperty('activeSubscriptions');
    expect(without).not.toHaveProperty('apiRequestsLast24h');

    await setScopes(w, ['overview:read']);
    const withOverview = await listApps();
    expect(withOverview).toHaveProperty('endUserCount');
    expect(withOverview).toHaveProperty('activeSubscriptions');
    expect(withOverview).toHaveProperty('apiRequestsLast24h');
  });

  it('a promotion sent together with scopes is refused before either write runs', async () => {
    const w = await world();
    await setScopes(w, ['organizations:read']);
    const r = await inject({
      method: 'PATCH',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
      headers: auth(w.ownerToken),
      payload: { role: 'ADMIN', scopes: ['billing:read'] },
    });
    expect(r.statusCode).toBe(400);
    // Nothing half-applied: still a MEMBER, still restricted to the old set.
    const roster = await inject({ method: 'GET', url: '/api/v1/tenant/workspace/members', headers: auth(w.ownerToken) });
    const row = (roster.json().data as { items: Array<{ membershipId: string; role: string; scopes: string[] | null }> }).items.find(
      (m) => m.membershipId === w.membershipId,
    )!;
    expect(row.role).toBe('MEMBER');
    expect(row.scopes).toEqual(['organizations:read']);
    expect((await rpc(w.pat, 'tools/list')).result!.tools!.map((t) => t.name)).not.toContain('list_plans');
  });
});
