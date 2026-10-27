/**
 * The operator MCP read tools for end-users, credits, licenses, webhook
 * deliveries, subscription imports, unapplied payments, dunning and
 * organizations answer for an Application the caller can read, and refuse
 * one in another workspace or one a MEMBER holds no grant on, with the same
 * APPLICATION_NOT_FOUND either way.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorMcpOAuthToken } from './operator-mcp-oauth-token.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const PASSWORD = 'pw-one-two-three';
const READ_SCOPE = 'mcp:operator:read';

interface ToolResult {
  isError: boolean;
  data: Record<string, unknown>;
}

interface Workspace {
  tenantId: string;
  ownerSession: string;
  ownerToken: string;
  memberToken: string;
  memberTenantUserId: string;
  outsiderToken: string;
  outsiderApp: string;
  appA: string;
  appB: string;
  endUserB: string;
  orgB: string;
  endpointA: string;
  endpointB: string;
}

describe('operator MCP application-scoped read tools', () => {
  let app: FastifyInstance;
  let n = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    const parsed = res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return { isError: parsed.result.isError === true, data: JSON.parse(parsed.result.content[0]!.text) };
  }

  async function signUp(email: string, workspaceName: string): Promise<{ accessToken: string; activeTenantId: string }> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: PASSWORD, workspaceName },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().data as { accessToken: string; activeTenantId: string };
  }

  /** An owner with apps A and B, a MEMBER invited with a grant on A only, and the owner of another workspace. */
  async function bootstrap(): Promise<Workspace> {
    const tag = `reads-${++n}-${Math.random().toString(36).slice(2, 7)}`;
    const owner = await signUp(`owner-${tag}@example.com`, 'Reads Co');
    const mkApp = async (suffix: string, session = owner.accessToken): Promise<string> => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: { authorization: `Bearer ${session}` },
        payload: { name: `App ${suffix}`, slug: `${tag}-${suffix}` },
      });
      expect(r.statusCode, r.body).toBe(201);
      return (r.json().data as { id: string }).id;
    };
    const appA = await mkApp('a');
    const appB = await mkApp('b');

    const endUserB = await prisma.endUser.create({ data: { applicationId: appB, email: `buyer-${tag}@example.com` } });
    const orgB = await prisma.organization.create({ data: { applicationId: appB, name: 'Acme', slug: `acme-${tag}` } });
    await prisma.organizationMembership.create({ data: { organizationId: orgB.id, endUserId: endUserB.id, role: 'OWNER' } });
    const endpoint = (applicationId: string) =>
      prisma.webhookEndpoint.create({ data: { applicationId, url: 'https://hooks.example.com/r', events: ['*'], secret: 'x'.repeat(64) } });
    const [endpointA, endpointB] = await Promise.all([endpoint(appA), endpoint(appB)]);

    const memberEmail = `member-${tag}@example.com`;
    const invitee = await signUp(memberEmail, 'Their Own Co');
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email: memberEmail, role: 'MEMBER', appGrants: [{ applicationId: appA, role: 'APP_VIEWER' }] },
    });
    expect(invite.statusCode, invite.body).toBe(201);
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${invitee.accessToken}` },
      payload: { token: (invite.json().data as { token: string }).token },
    });
    expect(accept.statusCode, accept.body).toBe(200);
    const memberSession = (accept.json().data as { accessToken: string }).accessToken;
    const memberUser = await prisma.tenantUser.findUniqueOrThrow({ where: { email: memberEmail } });

    const outsider = await signUp(`outsider-${tag}@example.com`, 'Elsewhere Co');

    return {
      tenantId: owner.activeTenantId,
      ownerSession: owner.accessToken,
      ownerToken: await operatorMcpOAuthToken(app, owner.accessToken, owner.activeTenantId, READ_SCOPE),
      memberToken: await operatorMcpOAuthToken(app, memberSession, owner.activeTenantId, READ_SCOPE),
      memberTenantUserId: memberUser.id,
      outsiderToken: await operatorMcpOAuthToken(app, outsider.accessToken, outsider.activeTenantId, READ_SCOPE),
      outsiderApp: await mkApp('elsewhere', outsider.accessToken),
      appA,
      appB,
      endUserB: endUserB.id,
      orgB: orgB.id,
      endpointA: endpointA.id,
      endpointB: endpointB.id,
    };
  }

  /** Arguments for each tool against app B, the one the MEMBER cannot read. */
  const APP_B_CALLS: Record<string, (ws: Workspace) => Record<string, unknown>> = {
    list_end_users: (ws) => ({ applicationId: ws.appB }),
    get_end_user_credits: (ws) => ({ applicationId: ws.appB, endUserId: ws.endUserB }),
    list_licenses: (ws) => ({ applicationId: ws.appB }),
    list_webhook_deliveries: (ws) => ({ applicationId: ws.appB, endpointId: ws.endpointB }),
    list_subscription_imports: (ws) => ({ applicationId: ws.appB }),
    list_unapplied_payments: (ws) => ({ applicationId: ws.appB }),
    get_dunning_status: (ws) => ({ applicationId: ws.appB }),
    get_organization: (ws) => ({ applicationId: ws.appB, organizationId: ws.orgB }),
  };

  it('the owner reads app B with every tool', async () => {
    const ws = await bootstrap();
    for (const [tool, args] of Object.entries(APP_B_CALLS)) {
      const r = await call(ws.ownerToken, tool, args(ws));
      expect(r.isError, `${tool} ${JSON.stringify(r.data)}`).toBe(false);
    }

    const users = await call(ws.ownerToken, 'list_end_users', { applicationId: ws.appB, search: 'BUYER-' });
    expect(users.data).toMatchObject({ total: 1, hasMore: false, endUsers: [{ id: ws.endUserB, bannedAt: null, createdVia: 'unknown' }] });
    expect(Object.keys((users.data.endUsers as object[])[0]!)).not.toContain('passwordHash');

    const credits = await call(ws.ownerToken, 'get_end_user_credits', APP_B_CALLS.get_end_user_credits!(ws));
    expect(credits.data).toEqual({ balance: 0, ledger: [] });

    const org = await call(ws.ownerToken, 'get_organization', APP_B_CALLS.get_organization!(ws));
    expect(org.data).toMatchObject({
      organization: { id: ws.orgB, name: 'Acme' },
      members: [{ endUserId: ws.endUserB, role: 'OWNER', baseRole: 'OWNER' }],
      invitations: [],
    });

    for (const tool of ['list_licenses', 'list_subscription_imports', 'list_unapplied_payments', 'get_dunning_status']) {
      const r = await call(ws.ownerToken, tool, { applicationId: ws.appB });
      expect(r.data, tool).toEqual({ items: [], total: 0, limit: 25, offset: 0, hasMore: false });
    }
  });

  it('another workspace and a MEMBER without a grant on app B are both refused, the same way', async () => {
    const ws = await bootstrap();
    for (const [label, token] of [['outsider', ws.outsiderToken], ['member', ws.memberToken]] as const) {
      for (const [tool, args] of Object.entries(APP_B_CALLS)) {
        const r = await call(token, tool, args(ws));
        expect(r, `${label} ${tool}`).toMatchObject({ isError: true, data: { code: 'APPLICATION_NOT_FOUND' } });
      }
    }
  });

  it('the MEMBER reads app A, the app their invitation granted', async () => {
    const ws = await bootstrap();
    for (const tool of ['list_end_users', 'list_licenses', 'list_subscription_imports', 'list_unapplied_payments', 'get_dunning_status']) {
      const r = await call(ws.memberToken, tool, { applicationId: ws.appA });
      expect(r.isError, `${tool} ${JSON.stringify(r.data)}`).toBe(false);
    }
    const deliveries = await call(ws.memberToken, 'list_webhook_deliveries', { applicationId: ws.appA, endpointId: ws.endpointA });
    expect(deliveries.data).toMatchObject({ deliveries: [], total: 0 });
  });

  it('an id from another application of the same workspace is not found', async () => {
    const ws = await bootstrap();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['list_webhook_deliveries', { applicationId: ws.appA, endpointId: ws.endpointB }, 'WEBHOOK_ENDPOINT_NOT_FOUND'],
      ['get_end_user_credits', { applicationId: ws.appA, endUserId: ws.endUserB }, 'END_USER_NOT_FOUND'],
      ['get_organization', { applicationId: ws.appA, organizationId: ws.orgB }, 'ORGANIZATION_NOT_FOUND'],
    ];
    for (const [tool, args, code] of cases) {
      expect(await call(ws.ownerToken, tool, args), tool).toMatchObject({ isError: true, data: { code } });
    }
  });

  it('list_member_grants shows the grants an invitation carried, to OWNER and ADMIN only', async () => {
    const ws = await bootstrap();
    const grants = await call(ws.ownerToken, 'list_member_grants', { tenantUserId: ws.memberTenantUserId });
    expect(grants.data).toMatchObject({ role: 'MEMBER', total: 1, grants: [{ applicationId: ws.appA, role: 'APP_VIEWER' }] });

    const asMember = await call(ws.memberToken, 'list_member_grants', { tenantUserId: ws.memberTenantUserId });
    expect(asMember.isError).toBe(true);
    expect(JSON.stringify(asMember.data)).toMatch(/requires at least the ADMIN role/);

    const asOutsider = await call(ws.outsiderToken, 'list_member_grants', { tenantUserId: ws.memberTenantUserId });
    expect(asOutsider).toMatchObject({ isError: true, data: { code: 'MEMBERSHIP_NOT_FOUND' } });
  });

  it('invite_member refuses appGrants naming an application in another workspace', async () => {
    const ws = await bootstrap();
    const adminToken = await operatorMcpOAuthToken(app, ws.ownerSession, ws.tenantId, `${READ_SCOPE} mcp:operator:write mcp:operator:admin`);
    const refused = await call(adminToken, 'invite_member', {
      email: 'someone@example.com',
      role: 'MEMBER',
      appGrants: [{ applicationId: ws.outsiderApp, role: 'APP_VIEWER' }],
    });
    expect(refused).toMatchObject({ isError: true, data: { code: 'APPLICATION_NOT_FOUND' } });
    const onAdmin = await call(adminToken, 'invite_member', {
      email: 'someone@example.com',
      role: 'ADMIN',
      appGrants: [{ applicationId: ws.appA, role: 'APP_VIEWER' }],
    });
    expect(onAdmin).toMatchObject({ isError: true, data: { code: 'APP_GRANT_MEMBER_ONLY' } });
    expect(await prisma.tenantInvitation.count({ where: { tenantId: ws.tenantId, email: 'someone@example.com' } })).toBe(0);
  });
});
