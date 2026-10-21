/**
 * Write tier must not be a road to admin tier.
 *
 * A write-tier token is an OAuth grant without `mcp:operator:admin`, or any
 * PAT. Held by an OWNER, it used to be able to invite a second OWNER, promote
 * a MEMBER, repoint where sign-in links land and register a webhook that
 * copies every event. Every write tool has a ruling below, and the registry is
 * read mechanically: a tool added later without a ruling fails this file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { allOperatorTools } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import { MCP_ADMIN_SCOPE, MCP_WRITE_SCOPE, operatorMcpOAuthToken } from './operator-mcp-oauth-token.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

interface Ruling {
  tier: 'write' | 'capped';
  why: string;
}

/**
 * One ruling per write tool that is not admin tier, answering: can a write
 * token of an OWNER use it, alone or chained, to get admin power, a
 * credential, or another person's data?
 */
const WRITE_TIER_RULINGS: Readonly<Record<string, Ruling>> = {
  invite_member: { tier: 'capped', why: 'An OWNER or ADMIN invitation is a new admin seat for an address the caller picks.' },
  remove_member: { tier: 'capped', why: 'Removing the other owners and admins leaves the token holder in sole control.' },
  create_organization_role: { tier: 'capped', why: 'A role above MEMBER tier is authority over customer organizations.' },
  update_organization_role: { tier: 'capped', why: 'Raising a tier promotes every holder at once.' },
  delete_organization_role: { tier: 'capped', why: 'Reassigning holders onto a privileged role promotes them.' },
  add_organization_member: { tier: 'capped', why: 'Adding a chosen end-user as an organization OWNER hands them that organization.' },
  set_organization_member_role: { tier: 'capped', why: 'Same as adding, for an existing member.' },
  revoke_invitation: { tier: 'write', why: 'Takes access away from an invitee who has not accepted. Grants nothing.' },
  create_application: { tier: 'write', why: 'Returns the publishable key only. No secret, no existing data.' },
  revoke_api_key: { tier: 'write', why: 'Can cause an outage, cannot obtain a key.' },
  release_device: { tier: 'write', why: 'Frees a device seat. Signing in still needs the end-user credentials.' },
  block_device: { tier: 'write', why: 'Refuses a device. Grants nothing.' },
  unblock_device: { tier: 'write', why: 'Undoes a block. Signing in still needs the end-user credentials.' },
  close_support_case: { tier: 'write', why: 'Ends support capabilities. Grants nothing.' },
  create_usage_meter: { tier: 'write', why: 'Billing configuration.' },
  put_plan_entitlement: { tier: 'write', why: 'Billing configuration.' },
  create_plan: { tier: 'write', why: 'Billing configuration.' },
  update_plan: { tier: 'write', why: 'Billing configuration.' },
  set_plan_active: { tier: 'write', why: 'Billing configuration.' },
  register_plan_with_provider: { tier: 'write', why: 'Uses stored provider credentials and returns none.' },
  set_plan_price: { tier: 'write', why: 'Can cost money (a zero price). Financial configuration, not escalation.' },
  remove_plan_price: { tier: 'write', why: 'Billing configuration.' },
  create_coupon: { tier: 'write', why: 'Can cost money (a 100% coupon). Financial configuration, not escalation.' },
  update_coupon: { tier: 'write', why: 'Same as create_coupon.' },
  set_reporting_currency: { tier: 'write', why: 'Changes how reports are totalled.' },
  set_profile_schema: { tier: 'write', why: 'Changes the onboarding questions. A field with answers keeps its key and type.' },
  update_end_user_profile: { tier: 'write', why: 'Sets profile answers. Sign-in and OIDC claims never read them.' },
  complete_onboarding: { tier: 'write', why: 'Records onboarding state, which never gates sign-in.' },
  skip_onboarding: { tier: 'write', why: 'Records onboarding state, which never gates sign-in.' },
  create_contact_list: { tier: 'write', why: 'List configuration. Grants nothing.' },
  update_contact_list: { tier: 'write', why: 'List configuration. Public capture lets browsers subscribe, never read.' },
  archive_contact_list: { tier: 'write', why: 'Stops subscribes. Keeps every member.' },
  restore_contact_list: { tier: 'write', why: 'Undoes an archive.' },
  unsubscribe_list_member: { tier: 'write', why: 'Takes someone off a list. Cannot add anyone back.' },
};

const ADMIN_TIER_TOOLS = [
  'update_auth_config',
  'create_webhook_endpoint',
  'update_webhook_endpoint',
  'change_member_role',
  'mint_api_key',
  'configure_billing_provider',
  'cancel_subscription',
  'create_refund',
] as const;

interface ToolResult {
  isError: boolean;
  data: Record<string, unknown>;
}

interface Fixture {
  tenantId: string;
  session: string;
  adminToken: string;
  appId: string;
  orgId: string;
  memberUserId: string;
  adminUserId: string;
  secondOwnerUserId: string;
  orgMemberEndUserId: string;
  orgOwnerEndUserId: string;
  outsiderEndUserId: string;
}

type Attempt = Record<string, unknown>;

/** Every way a capped tool could hand out or take away OWNER or ADMIN authority. The first of each also runs with an admin token. */
const ESCALATIONS: Readonly<Record<string, (f: Fixture) => Attempt[]>> = {
  invite_member: () => [
    { email: 'accomplice-owner@example.com', role: 'OWNER' },
    { email: 'accomplice-admin@example.com', role: 'ADMIN' },
  ],
  remove_member: (f) => [{ tenantUserId: f.adminUserId }, { tenantUserId: f.secondOwnerUserId }],
  create_organization_role: (f) => [
    { applicationId: f.appId, name: 'shadow-admin', baseRole: 'ADMIN' },
    { applicationId: f.appId, name: 'shadow-owner', baseRole: 'OWNER' },
  ],
  update_organization_role: (f) => [
    { applicationId: f.appId, name: 'writer', baseRole: 'ADMIN' },
    { applicationId: f.appId, name: 'writer', baseRole: 'OWNER' },
    { applicationId: f.appId, name: 'lead', isDefault: true },
    { applicationId: f.appId, name: 'lead', baseRole: 'MEMBER' },
  ],
  delete_organization_role: (f) => [
    { applicationId: f.appId, name: 'lead' },
    { applicationId: f.appId, name: 'writer', reassignTo: 'OWNER' },
    { applicationId: f.appId, name: 'writer', reassignTo: 'lead' },
  ],
  add_organization_member: (f) => [
    { applicationId: f.appId, organizationId: f.orgId, endUserId: f.outsiderEndUserId, role: 'OWNER' },
    { applicationId: f.appId, organizationId: f.orgId, endUserId: f.outsiderEndUserId, role: 'lead' },
  ],
  set_organization_member_role: (f) => [
    { applicationId: f.appId, organizationId: f.orgId, endUserId: f.orgMemberEndUserId, role: 'OWNER' },
    { applicationId: f.appId, organizationId: f.orgId, endUserId: f.orgMemberEndUserId, role: 'lead' },
    { applicationId: f.appId, organizationId: f.orgId, endUserId: f.orgOwnerEndUserId, role: 'MEMBER' },
  ],
};

const ADMIN_TOOL_ARGS: Readonly<Record<(typeof ADMIN_TIER_TOOLS)[number], (f: Fixture) => Attempt>> = {
  update_auth_config: (f) => ({ applicationId: f.appId, appUrl: 'https://attacker.example', mfa: 'off' }),
  create_webhook_endpoint: (f) => ({ applicationId: f.appId, url: 'https://attacker.example/hook', events: ['*'] }),
  update_webhook_endpoint: (f) => ({ applicationId: f.appId, endpointId: 'whe_any', url: 'https://attacker.example/hook' }),
  change_member_role: (f) => ({ tenantUserId: f.memberUserId, newRole: 'OWNER' }),
  mint_api_key: (f) => ({ applicationId: f.appId, name: 'stolen' }),
  configure_billing_provider: (f) => ({ applicationId: f.appId, provider: 'stripe', apiKey: 'sk_test_x' }),
  cancel_subscription: () => ({ subscriptionId: 'sub_any' }),
  create_refund: (f) => ({ applicationId: f.appId, paymentId: 'pay_any' }),
};

describe('operator MCP write tier cannot reach admin tier', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function mintPat(session: string, scopes: string[]): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${session}` },
      payload: { name: 'agent', scopes },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { rawToken: string }).rawToken;
  }

  async function call(token: string, name: string, args: Attempt): Promise<ToolResult> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    const parsed = res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return { isError: parsed.result.isError === true, data: JSON.parse(parsed.result.content[0]!.text) };
  }

  async function listed(token: string): Promise<string[]> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    return (res.json().result.tools as Array<{ name: string }>).map((t) => t.name);
  }

  async function seedWorkspaceMember(tenantId: string, email: string, role: 'OWNER' | 'ADMIN' | 'MEMBER'): Promise<string> {
    const user = await prisma.tenantUser.create({ data: { email } });
    await prisma.tenantMembership.create({ data: { tenantUserId: user.id, tenantId, role } });
    return user.id;
  }

  async function fixture(slug: string): Promise<Fixture> {
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `tier-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
    });
    const data = signUp.json().data as { accessToken: string; activeTenantId: string };
    const tenantId = data.activeTenantId;
    const adminToken = await operatorMcpOAuthToken(app, data.accessToken, tenantId, MCP_ADMIN_SCOPE);

    const created = await call(adminToken, 'create_application', { name: `App ${slug}`, slug: `tier-${slug}` });
    const appId = created.data.id as string;
    expect((await call(adminToken, 'update_auth_config', { applicationId: appId, organizationsEnabled: true })).isError).toBe(false);
    for (const role of [
      { name: 'lead', baseRole: 'ADMIN' },
      { name: 'writer', baseRole: 'MEMBER' },
      { name: 'reader', baseRole: 'MEMBER' },
    ]) {
      expect((await call(adminToken, 'create_organization_role', { applicationId: appId, ...role })).isError).toBe(false);
    }

    const org = await prisma.organization.create({ data: { applicationId: appId, name: 'Acme', slug: `acme-${slug}` } });
    const endUser = (email: string) => prisma.endUser.create({ data: { applicationId: appId, email } });
    const [orgMember, orgOwner, outsider] = await Promise.all([
      endUser(`member-${slug}@example.com`),
      endUser(`owner-${slug}@example.com`),
      endUser(`outsider-${slug}@example.com`),
    ]);
    await prisma.organizationMembership.createMany({
      data: [
        { organizationId: org.id, endUserId: orgMember.id, role: 'MEMBER' },
        { organizationId: org.id, endUserId: orgOwner.id, role: 'OWNER' },
      ],
    });

    return {
      tenantId,
      session: data.accessToken,
      adminToken,
      appId,
      orgId: org.id,
      memberUserId: await seedWorkspaceMember(tenantId, `ws-member-${slug}@example.com`, 'MEMBER'),
      adminUserId: await seedWorkspaceMember(tenantId, `ws-admin-${slug}@example.com`, 'ADMIN'),
      secondOwnerUserId: await seedWorkspaceMember(tenantId, `ws-owner2-${slug}@example.com`, 'OWNER'),
      orgMemberEndUserId: orgMember.id,
      orgOwnerEndUserId: orgOwner.id,
      outsiderEndUserId: outsider.id,
    };
  }

  /** Everything that carries authority, a credential or a data stream in the workspace. */
  async function authoritySnapshot(f: Fixture): Promise<unknown> {
    const [memberships, invitations, roles, orgMemberships, application, endpoints, apiKeys, pats, credentials] = await Promise.all([
      prisma.tenantMembership.findMany({ where: { tenantId: f.tenantId }, select: { tenantUserId: true, role: true }, orderBy: { tenantUserId: 'asc' } }),
      prisma.tenantInvitation.findMany({ where: { tenantId: f.tenantId, role: { not: 'MEMBER' } }, select: { email: true, role: true } }),
      prisma.organizationRoleDef.findMany({ where: { applicationId: f.appId }, select: { name: true, baseRole: true, isDefault: true }, orderBy: { name: 'asc' } }),
      prisma.organizationMembership.findMany({ where: { organizationId: f.orgId }, select: { endUserId: true, role: true }, orderBy: { endUserId: 'asc' } }),
      prisma.application.findUniqueOrThrow({ where: { id: f.appId }, select: { authConfig: true } }),
      prisma.webhookEndpoint.findMany({ where: { applicationId: f.appId }, select: { url: true } }),
      prisma.apiKey.count({ where: { applicationId: f.appId } }),
      prisma.tenantApiToken.count({ where: { tenantId: f.tenantId } }),
      prisma.billingCredentials.count({ where: { applicationId: f.appId } }),
    ]);
    return { memberships, invitations, roles, orgMemberships, authConfig: application.authConfig, endpoints, apiKeys, pats, credentials };
  }

  it('every write tool has a ruling, and the admin tier is exactly the ruled set', () => {
    const writeTier = allOperatorTools.filter((t) => t.write === true && t.admin !== true).map((t) => t.name);
    expect(writeTier.sort()).toEqual(Object.keys(WRITE_TIER_RULINGS).sort());
    expect(allOperatorTools.filter((t) => t.admin === true).map((t) => t.name).sort()).toEqual([...ADMIN_TIER_TOOLS].sort());

    const capped = Object.entries(WRITE_TIER_RULINGS).filter(([, r]) => r.tier === 'capped').map(([name]) => name);
    expect(Object.keys(ESCALATIONS).sort()).toEqual(capped.sort());
  });

  it('a PAT with applications:write, and a write-only OAuth token, cannot reach OWNER or admin power by any write tool', async () => {
    const f = await fixture('chain');
    const pat = await mintPat(f.session, ['read', 'applications:write']);
    const writeOnly = await operatorMcpOAuthToken(app, f.session, f.tenantId, MCP_WRITE_SCOPE);
    const before = await authoritySnapshot(f);

    for (const [label, token] of [['PAT', pat], ['write-only OAuth', writeOnly]] as const) {
      const names = await listed(token);
      for (const admin of ADMIN_TIER_TOOLS) expect(names, `${label} lists ${admin}`).not.toContain(admin);
      for (const write of Object.keys(WRITE_TIER_RULINGS)) expect(names, `${label} lists ${write}`).toContain(write);

      for (const tool of ADMIN_TIER_TOOLS) {
        const refused = await call(token, tool, ADMIN_TOOL_ARGS[tool](f));
        expect(refused, `${label} ${tool}`).toMatchObject({ isError: true, data: { code: 'OPERATOR_MCP_ADMIN_REQUIRED' } });
      }
      for (const tool of allOperatorTools.filter((t) => t.write === true && t.admin !== true)) {
        if (WRITE_TIER_RULINGS[tool.name]?.tier !== 'capped') continue;
        for (const args of ESCALATIONS[tool.name]!(f)) {
          const refused = await call(token, tool.name, args);
          expect(refused, `${label} ${tool.name} ${JSON.stringify(args)}`).toMatchObject({
            isError: true,
            data: { code: 'OPERATOR_MCP_ADMIN_REQUIRED' },
          });
          expect(String(refused.data.fix)).toContain('OAuth');
        }
      }
    }

    expect(await authoritySnapshot(f)).toEqual(before);
  });

  it('a default organization role above MEMBER tier is not handed out by omitting the role', async () => {
    const f = await fixture('default');
    const pat = await mintPat(f.session, ['read', 'applications:write']);
    expect((await call(f.adminToken, 'update_organization_role', { applicationId: f.appId, name: 'lead', isDefault: true })).isError).toBe(false);

    const refused = await call(pat, 'add_organization_member', {
      applicationId: f.appId,
      organizationId: f.orgId,
      endUserId: f.outsiderEndUserId,
    });
    expect(refused).toMatchObject({ isError: true, data: { code: 'OPERATOR_MCP_ADMIN_REQUIRED' } });
    expect(
      await prisma.organizationMembership.count({ where: { organizationId: f.orgId, endUserId: f.outsiderEndUserId } }),
    ).toBe(0);
  });

  it('write tier still does MEMBER-level work with every capped tool', async () => {
    const f = await fixture('member');
    const pat = await mintPat(f.session, ['read', 'applications:write']);
    const writeOnly = await operatorMcpOAuthToken(app, f.session, f.tenantId, MCP_WRITE_SCOPE);
    const org = { applicationId: f.appId, organizationId: f.orgId };

    const allowed: Array<[string, string, Attempt]> = [
      [pat, 'invite_member', { email: 'teammate@example.com', role: 'MEMBER' }],
      [writeOnly, 'invite_member', { email: 'teammate2@example.com', role: 'MEMBER' }],
      [pat, 'create_organization_role', { applicationId: f.appId, name: 'editor', baseRole: 'MEMBER' }],
      [writeOnly, 'update_organization_role', { applicationId: f.appId, name: 'writer', description: 'Writes things' }],
      [pat, 'update_organization_role', { applicationId: f.appId, name: 'writer', baseRole: 'MEMBER', isDefault: true }],
      [pat, 'add_organization_member', { ...org, endUserId: f.outsiderEndUserId, role: 'reader' }],
      [writeOnly, 'set_organization_member_role', { ...org, endUserId: f.outsiderEndUserId, role: 'editor' }],
      [pat, 'set_organization_member_role', { ...org, endUserId: f.orgMemberEndUserId, role: 'reader' }],
      [pat, 'delete_organization_role', { applicationId: f.appId, name: 'reader', reassignTo: 'editor' }],
      [writeOnly, 'remove_member', { tenantUserId: f.memberUserId }],
    ];
    for (const [token, tool, args] of allowed) {
      const done = await call(token, tool, args);
      expect(done.isError, `${tool} ${JSON.stringify(args)} ${JSON.stringify(done.data)}`).toBe(false);
    }
    expect(Object.keys(ESCALATIONS).every((tool) => allowed.some(([, name]) => name === tool))).toBe(true);
  });

  it('an admin-tier token is allowed what write tier is refused', async () => {
    const f = await fixture('admin');
    expect(await listed(f.adminToken)).toEqual(expect.arrayContaining([...ADMIN_TIER_TOOLS]));

    for (const [tool, attempts] of Object.entries(ESCALATIONS)) {
      const args = attempts(f)[0]!;
      const done = await call(f.adminToken, tool, args);
      expect(done.isError, `${tool} ${JSON.stringify(args)} ${JSON.stringify(done.data)}`).toBe(false);
    }
    const promoted = await call(f.adminToken, 'change_member_role', { tenantUserId: f.memberUserId, newRole: 'ADMIN' });
    expect(promoted).toMatchObject({ isError: false, data: { role: 'ADMIN' } });
    const hook = await call(f.adminToken, 'create_webhook_endpoint', {
      applicationId: f.appId,
      url: 'https://hooks.example.com/rekey',
      events: ['*'],
    });
    expect(hook.isError).toBe(false);
  });

  it('a PAT with applications:write is not accepted by the REST routes that manage members, auth config or webhooks', async () => {
    const f = await fixture('rest');
    const pat = await mintPat(f.session, ['read', 'applications:write']);
    const membership = await prisma.tenantMembership.findUniqueOrThrow({
      where: { tenantUserId_tenantId: { tenantUserId: f.memberUserId, tenantId: f.tenantId } },
    });
    const before = await authoritySnapshot(f);

    const attempts = [
      { method: 'POST', url: '/api/v1/tenant/workspace/invitations', payload: { email: 'rest-owner@example.com', role: 'OWNER' } },
      { method: 'PATCH', url: `/api/v1/tenant/workspace/members/${membership.id}`, payload: { role: 'OWNER' } },
      { method: 'PATCH', url: `/api/v1/tenant/applications/${f.appId}/auth-config`, payload: { appUrl: 'https://attacker.example' } },
      { method: 'POST', url: `/api/v1/tenant/applications/${f.appId}/webhooks`, payload: { url: 'https://attacker.example/hook', events: ['*'] } },
    ] as const;
    for (const attempt of attempts) {
      const res = await app.inject({ ...attempt, headers: { authorization: `Bearer ${pat}` } });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(401);
      expect(res.json().error.code).toBe('TENANT_SESSION_INVALID');
    }
    expect(await authoritySnapshot(f)).toEqual(before);

    for (const attempt of attempts.slice(0, 2)) {
      const withSession = await app.inject({ ...attempt, headers: { authorization: `Bearer ${f.session}` } });
      expect(withSession.statusCode, `session ${attempt.method} ${attempt.url}`).toBeLessThan(300);
    }
  });
});
