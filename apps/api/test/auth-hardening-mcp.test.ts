/**
 * Finding 7: operator MCP read tools ignored the role gate and per-app grants.
 *
 * Reproduced against a running server: an `APP_VIEWER` MEMBER — granted sight
 * of exactly one Application — minted themselves an OAuth token, then read
 * another Application's end-users and the full workspace security log (IPs,
 * user agents) through MCP. The REST equivalents answer 404 and 403 for the
 * same account.
 *
 * These drive the OAuth self-grant, which is the credential a MEMBER can
 * actually obtain: minting a PAT is OWNER/ADMIN-only, so "self-granted an OAuth
 * token" is not a detail of the report but the whole reason the hole was
 * reachable by the account it was reachable by.
 *
 * The `tools/list` assertions matter as much as the `tools/call` ones — a tool
 * a caller cannot use must not be advertised to their agent.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const PASSWORD = 'pw-one-two-three';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

interface Workspace {
  ownerToken: string;
  memberToken: string;
  membershipId: string;
  tenantId: string;
  appA: string;
  appB: string;
  endUserBEmail: string;
}

describe('operator MCP read authorization', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  let ip = '10.55.0.1';
  function inject(opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: ip, ...opts } as never);
  }

  async function signUp(email: string, workspaceName: string): Promise<string> {
    const r = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: PASSWORD, workspaceName },
    });
    expect(r.statusCode, r.body).toBe(201);
    return (r.json().data as { accessToken: string }).accessToken;
  }

  /**
   * Mint an operator-MCP OAuth access token for a session, the way an MCP
   * client would: register → grant (session-authenticated) → exchange the code.
   * A MEMBER can do all three for their own workspace, which is what made the
   * read tools reachable by an account that cannot mint a PAT.
   */
  async function mintOauthToken(session: string, tenantId: string): Promise<string> {
    const client = await inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/register',
      payload: { redirect_uris: [REDIRECT], client_name: 'Agent' },
    });
    expect(client.statusCode, client.body).toBe(201);
    const clientId = (client.json() as { client_id: string }).client_id;
    const { verifier, challenge } = pkce();

    const grant = await inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/grant',
      headers: { authorization: `Bearer ${session}` },
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp:operator:read',
        tenant_id: tenantId,
        approve: true,
      },
    });
    expect(grant.statusCode, grant.body).toBe(200);
    const code = new URL((grant.json() as { data: { redirect: string } }).data.redirect)
      .searchParams.get('code');

    const token = await inject({
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
    expect(token.statusCode, token.body).toBe(200);
    return (token.json() as { access_token: string }).access_token;
  }

  /** Owner + two Applications + one MEMBER, with an end-user in app B. */
  async function bootstrap(): Promise<Workspace> {
    ip = `10.55.${++n}.1`;
    const tag = `mcpauth-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const ownerSignUp = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `owner-${tag}@example.com`,
        password: PASSWORD,
        workspaceName: 'Grants Co',
      },
    });
    expect(ownerSignUp.statusCode, ownerSignUp.body).toBe(201);
    const { accessToken: ownerToken, activeTenantId: tenantId } = ownerSignUp.json().data as {
      accessToken: string;
      activeTenantId: string;
    };
    const memberEmail = `member-${tag}@example.com`;
    const inviteeToken = await signUp(memberEmail, 'Their Own Co');

    const mkApp = async (suffix: string): Promise<string> => {
      const r = await inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { name: `App ${suffix}`, slug: `${tag}-${suffix}` },
      });
      expect(r.statusCode, r.body).toBe(201);
      return (r.json().data as { id: string }).id;
    };
    const appA = await mkApp('a');
    const appB = await mkApp('b');

    // An end-user in app B — the one the MEMBER has no grant on.
    const liveKey = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appB}/api-keys`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'k', mode: 'live' },
    }).then((r) => (r.json().data as { rawKey: string }).rawKey);
    const endUserBEmail = `secret-user-${tag}@example.com`;
    await inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: endUserBEmail, password: PASSWORD },
    });

    const invite = await inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { email: memberEmail, role: 'MEMBER' },
    });
    expect(invite.statusCode, invite.body).toBe(201);
    const accept = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${inviteeToken}` },
      payload: { token: (invite.json().data as { token: string }).token },
    });
    expect(accept.statusCode, accept.body).toBe(200);
    const memberToken = (accept.json().data as { accessToken: string }).accessToken;

    const members = await inject({
      method: 'GET',
      url: '/api/v1/tenant/workspace/members',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const membershipId = (
      members.json().data as { items: Array<{ membershipId: string; email: string }> }
    ).items.find((m) => m.email === memberEmail)!.membershipId;

    return { ownerToken, memberToken, membershipId, tenantId, appA, appB, endUserBEmail };
  }

  async function grantViewer(ws: Workspace, applicationId: string): Promise<void> {
    const r = await inject({
      method: 'PUT',
      url: `/api/v1/tenant/workspace/members/${ws.membershipId}/grants`,
      headers: { authorization: `Bearer ${ws.ownerToken}` },
      payload: { applicationId, role: 'APP_VIEWER' },
    });
    expect(r.statusCode, r.body).toBeLessThan(300);
  }

  function rpc(token: string, method: string, params?: Record<string, unknown>) {
    return inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    });
  }

  function toolResult(body: string): { isError: boolean; data: unknown } {
    const p = JSON.parse(body) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    return { isError: p.result.isError === true, data: JSON.parse(p.result.content[0]!.text) };
  }

  it('GET on the MCP endpoint 405s with Allow: POST and a complete error envelope', async () => {
    // This handler used to build its envelope by hand, which skipped
    // `rekeyErrorHandler` and dropped `requestId`. It now sets the header and
    // THROWS — so this also pins that a header set before the throw survives it.
    const ws = await bootstrap();
    const token = await mintOauthToken(ws.ownerToken, ws.tenantId);
    const res = await inject({
      method: 'GET',
      url: '/api/v1/tenant/mcp',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST');
    const err = res.json().error;
    expect(err.code).toBe('METHOD_NOT_ALLOWED');
    expect(err.requestId).toEqual(expect.any(String));
    expect(res.headers['x-request-id']).toBe(err.requestId);
  });

  it('an APP_VIEWER MEMBER cannot read another Application\'s end-users', async () => {
    const ws = await bootstrap();
    await grantViewer(ws, ws.appA);
    const token = await mintOauthToken(ws.memberToken, ws.tenantId);

    const denied = toolResult(
      (
        await rpc(token, 'tools/call', {
          name: 'get_end_user',
          arguments: { applicationId: ws.appB, email: ws.endUserBEmail },
        })
      ).body,
    );
    // Was `{ found: true, endUser: { … } }` — the profile of a user in an
    // Application this member has no grant on. The REST route answers 404, and
    // the refusal here is deliberately the same shape as "no such Application"
    // so existence does not leak through it.
    expect(denied.data).toEqual({ found: false, reason: 'application_not_found_in_workspace' });

    // The granted Application still works — this is a scope, not a lockout.
    const allowed = toolResult(
      (
        await rpc(token, 'tools/call', {
          name: 'get_end_user',
          arguments: { applicationId: ws.appA, email: 'nobody@example.com' },
        })
      ).body,
    );
    expect(allowed.data).toEqual({ found: false });
  });

  it('list_applications and the workspace rollup honour grants', async () => {
    const ws = await bootstrap();
    await grantViewer(ws, ws.appA);
    const token = await mintOauthToken(ws.memberToken, ws.tenantId);

    const list = toolResult((await rpc(token, 'tools/call', { name: 'list_applications' })).body);
    const ids = (list.data as { applications: Array<{ id: string }> }).applications.map(
      (a) => a.id,
    );
    expect(ids).toEqual([ws.appA]);

    const overview = toolResult(
      (await rpc(token, 'tools/call', { name: 'get_workspace_overview' })).body,
    );
    // Was 2 — the rollup counted every Application in the workspace, which is
    // also how it leaked end-user and revenue totals for apps behind no grant.
    expect((overview.data as { applicationCount: number }).applicationCount).toBe(1);
  });

  it('a MEMBER cannot read the workspace security log, and is not offered it', async () => {
    const ws = await bootstrap();
    await grantViewer(ws, ws.appA);
    const token = await mintOauthToken(ws.memberToken, ws.tenantId);

    const listed = JSON.parse((await rpc(token, 'tools/list')).body) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = listed.result.tools.map((t) => t.name);
    // A tool the caller cannot use must not be advertised — otherwise their
    // agent plans around it and reports a confusing failure.
    expect(names).not.toContain('recent_security_events');
    expect(names).not.toContain('list_invitations');

    const called = toolResult(
      (await rpc(token, 'tools/call', { name: 'recent_security_events' })).body,
    );
    // Was the full log: every sign-in, IP and user agent in the workspace,
    // while GET /api/v1/tenant/security-events answered 403 for this account.
    expect(called.isError).toBe(true);
    expect(JSON.stringify(called.data)).toMatch(/requires at least the ADMIN role/);
  });

  it('a MEMBER with zero grants sees no Applications over MCP either', async () => {
    // Mirrors `lib/app-access.ts`: since 2.0.0-rc.3 grant-scoped is the
    // DEFAULT, so a freshly invited member reaches nothing. The MCP surface
    // must not be the way around the REST contract.
    const ws = await bootstrap();
    const token = await mintOauthToken(ws.memberToken, ws.tenantId);
    const list = toolResult((await rpc(token, 'tools/call', { name: 'list_applications' })).body);
    expect((list.data as { applications: unknown[] }).applications).toEqual([]);
  });

  it('a GRANDFATHERED membership keeps workspace-wide read over MCP', async () => {
    // A member who predates grant-scoped-by-default must not lose access the
    // day this shipped — the same backfilled flag the REST tests assert.
    const ws = await bootstrap();
    await prisma.tenantMembership.update({
      where: { id: ws.membershipId },
      data: { legacyWorkspaceRead: true },
    });
    const token = await mintOauthToken(ws.memberToken, ws.tenantId);
    const list = toolResult((await rpc(token, 'tools/call', { name: 'list_applications' })).body);
    const ids = (list.data as { applications: Array<{ id: string }> }).applications.map(
      (a) => a.id,
    );
    expect(ids.sort()).toEqual([ws.appA, ws.appB].sort());
  });

  it('OWNER is unaffected — every read tool still returns the whole workspace', async () => {
    const ws = await bootstrap();
    const token = await mintOauthToken(ws.ownerToken, ws.tenantId);

    const list = toolResult((await rpc(token, 'tools/call', { name: 'list_applications' })).body);
    expect((list.data as { applications: unknown[] }).applications).toHaveLength(2);

    const events = toolResult(
      (await rpc(token, 'tools/call', { name: 'recent_security_events' })).body,
    );
    expect(events.isError).toBe(false);
  });
});
