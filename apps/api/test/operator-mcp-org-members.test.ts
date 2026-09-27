/**
 * Operator MCP organization-membership tools: `list_organizations`,
 * `add_organization_member`, `set_organization_member_role` (#591).
 *
 * Load-bearing cases:
 *   - a read-only credential never sees the two writes and is refused if it
 *     calls one, with no membership written;
 *   - write scope alone is not enough, a MEMBER is refused;
 *   - another workspace's Application, organization or end-user reads as not
 *     found and nothing is written there;
 *   - the role must be in the Application's catalog and not disabled;
 *   - organizations must be enabled on the Application;
 *   - each refusal carries its code and a fix that names an MCP tool;
 *   - arguments are validated, not coerced ("undefined" is not an id);
 *   - the REST routes audit the same writes, since the service records them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { invalidateOrganizationRoles } from '../src/lib/organization-role-cache.js';
import { UNRESTRICTED } from '../src/lib/operator-scopes.js';
import { handleOperatorMcpMessage } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

interface ToolResult {
  isError: boolean;
  data: Record<string, unknown>;
}

interface Workspace {
  tenantId: string;
  accessToken: string;
  token: string;
  appId: string;
  orgId: string;
  endUserId: string;
}

const WRITE_TOOLS = ['add_organization_member', 'set_organization_member_role'] as const;

describe('Operator MCP organization membership tools', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function signUp(slug: string): Promise<{ accessToken: string; tenantId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `mcporg-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
    });
    const data = res.json().data as { accessToken: string; activeTenantId: string };
    return { accessToken: data.accessToken, tenantId: data.activeTenantId };
  }

  async function mintPat(accessToken: string, scopes: string[]): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'mcp-agent', scopes },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { rawToken: string }).rawToken;
  }

  async function rpc(token: string, method: string, params?: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    });
  }

  async function call(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const res = await rpc(token, 'tools/call', { name, arguments: args });
    const parsed = res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return { isError: parsed.result.isError === true, data: JSON.parse(parsed.result.content[0]!.text) };
  }

  async function listed(token: string): Promise<string[]> {
    const res = await rpc(token, 'tools/list');
    return (res.json().result.tools as Array<{ name: string }>).map((t) => t.name);
  }

  /** A workspace with one organizations-enabled app, one organization, one end-user and a custom role. */
  async function workspace(slug: string, opts: { organizationsEnabled?: boolean } = {}): Promise<Workspace> {
    const { accessToken, tenantId } = await signUp(slug);
    const token = await mintPat(accessToken, ['read', 'applications:write']);
    const created = await call(token, 'create_application', { name: `App ${slug}`, slug: `org-${slug}` });
    expect(created.isError).toBe(false);
    const appId = created.data.id as string;
    await call(token, 'update_auth_config', { applicationId: appId, organizationsEnabled: true });
    const role = await call(token, 'create_organization_role', {
      applicationId: appId,
      name: 'content-manager',
      baseRole: 'ADMIN',
    });
    expect(role.isError).toBe(false);
    if (opts.organizationsEnabled === false) {
      await call(token, 'update_auth_config', { applicationId: appId, organizationsEnabled: false });
    }
    const org = await prisma.organization.create({ data: { applicationId: appId, name: 'Acme', slug: 'acme' } });
    const endUser = await prisma.endUser.create({ data: { applicationId: appId, email: `eu-${slug}@example.com` } });
    return { tenantId, accessToken, token, appId, orgId: org.id, endUserId: endUser.id };
  }

  function membership(orgId: string, endUserId: string) {
    return prisma.organizationMembership.findUnique({
      where: { organizationId_endUserId: { organizationId: orgId, endUserId } },
    });
  }

  it('adds a member with a catalog role, changes it, and audits both', async () => {
    const w = await workspace('happy');

    const orgs = await call(w.token, 'list_organizations', { applicationId: w.appId });
    expect(orgs.isError).toBe(false);
    expect(orgs.data).toMatchObject({ total: 1, organizations: [{ id: w.orgId, slug: 'acme', memberCount: 0 }] });

    const added = await call(w.token, 'add_organization_member', {
      applicationId: w.appId,
      organizationId: w.orgId,
      endUserId: w.endUserId,
      role: 'content-manager',
    });
    expect(added.isError).toBe(false);
    expect(added.data).toMatchObject({
      organizationId: w.orgId,
      endUserId: w.endUserId,
      email: 'eu-happy@example.com',
      role: 'content-manager',
      baseRole: 'ADMIN',
    });
    expect((await membership(w.orgId, w.endUserId))?.role).toBe('content-manager');

    const changed = await call(w.token, 'set_organization_member_role', {
      applicationId: w.appId,
      organizationId: w.orgId,
      endUserId: w.endUserId,
      role: 'OWNER',
    });
    expect(changed.isError).toBe(false);
    expect(changed.data).toMatchObject({ role: 'OWNER', baseRole: 'OWNER' });
    expect((await membership(w.orgId, w.endUserId))?.role).toBe('OWNER');

    const [addEvent] = await waitForSecurityEvents({ tenantId: w.tenantId, type: 'app.organization_member_added' });
    expect(addEvent!.metadata).toMatchObject({
      via: 'operator_mcp',
      organizationId: w.orgId,
      endUserId: w.endUserId,
      role: 'content-manager',
    });
    const [roleEvent] = await waitForSecurityEvents({
      tenantId: w.tenantId,
      type: 'app.organization_member_role_changed',
    });
    expect(roleEvent!.metadata).toMatchObject({ via: 'operator_mcp', role: 'OWNER', baseRole: 'OWNER' });
  });

  it("uses the catalog's default role when none is given", async () => {
    const w = await workspace('default');
    const added = await call(w.token, 'add_organization_member', {
      applicationId: w.appId,
      organizationId: w.orgId,
      endUserId: w.endUserId,
    });
    expect(added.isError).toBe(false);
    expect(added.data).toMatchObject({ role: 'MEMBER', baseRole: 'MEMBER' });
  });

  it('refuses a role outside the catalog, and a disabled one, writing nothing', async () => {
    const w = await workspace('unknown');
    const unknown = await call(w.token, 'add_organization_member', {
      applicationId: w.appId,
      organizationId: w.orgId,
      endUserId: w.endUserId,
      role: 'superuser',
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.data).toMatchObject({ code: 'ORGANIZATION_ROLE_UNKNOWN' });
    expect(unknown.data.fix).toMatch(/list_organization_roles/);
    expect(await membership(w.orgId, w.endUserId)).toBeNull();

    await prisma.organizationRoleDef.update({
      where: { applicationId_name: { applicationId: w.appId, name: 'content-manager' } },
      data: { disabled: true },
    });
    invalidateOrganizationRoles(w.appId);
    const disabled = await call(w.token, 'add_organization_member', {
      applicationId: w.appId,
      organizationId: w.orgId,
      endUserId: w.endUserId,
      role: 'content-manager',
    });
    expect(disabled.isError).toBe(true);
    expect(disabled.data).toMatchObject({ code: 'ORGANIZATION_ROLE_DISABLED' });
    expect(await membership(w.orgId, w.endUserId)).toBeNull();

    await call(w.token, 'add_organization_member', {
      applicationId: w.appId,
      organizationId: w.orgId,
      endUserId: w.endUserId,
      role: 'MEMBER',
    });
    const set = await call(w.token, 'set_organization_member_role', {
      applicationId: w.appId,
      organizationId: w.orgId,
      endUserId: w.endUserId,
      role: 'superuser',
    });
    expect(set.isError).toBe(true);
    expect(set.data).toMatchObject({ code: 'ORGANIZATION_ROLE_UNKNOWN' });
    expect((await membership(w.orgId, w.endUserId))?.role).toBe('MEMBER');
  });

  it('points each tool at the other when the membership is or is not there', async () => {
    const w = await workspace('pointers');
    const missing = await call(w.token, 'set_organization_member_role', {
      applicationId: w.appId,
      organizationId: w.orgId,
      endUserId: w.endUserId,
      role: 'MEMBER',
    });
    expect(missing.isError).toBe(true);
    expect(missing.data).toMatchObject({ code: 'ORGANIZATION_MEMBER_NOT_FOUND' });
    expect(missing.data.fix).toMatch(/add_organization_member/);

    const args = { applicationId: w.appId, organizationId: w.orgId, endUserId: w.endUserId };
    expect((await call(w.token, 'add_organization_member', args)).isError).toBe(false);
    const again = await call(w.token, 'add_organization_member', args);
    expect(again.isError).toBe(true);
    expect(again.data).toMatchObject({ code: 'ORGANIZATION_ALREADY_MEMBER' });
    expect(again.data.fix).toMatch(/set_organization_member_role/);
  });

  it('refuses both writes while organizations are disabled', async () => {
    const w = await workspace('disabled', { organizationsEnabled: false });
    for (const name of WRITE_TOOLS) {
      const r = await call(w.token, name, {
        applicationId: w.appId,
        organizationId: w.orgId,
        endUserId: w.endUserId,
        role: 'MEMBER',
      });
      expect(r.isError).toBe(true);
      expect(r.data).toMatchObject({ code: 'ORGANIZATIONS_NOT_ENABLED' });
      expect(r.data.fix).toMatch(/update_auth_config/);
    }
    expect(await membership(w.orgId, w.endUserId)).toBeNull();
  });

  it('a read-only PAT sees list_organizations but not the writes, and is refused if it calls one', async () => {
    const w = await workspace('readonly');
    const readOnly = await mintPat(w.accessToken, ['read']);

    const names = await listed(readOnly);
    expect(names).toContain('list_organizations');
    for (const name of WRITE_TOOLS) expect(names).not.toContain(name);

    for (const name of WRITE_TOOLS) {
      const r = await call(readOnly, name, {
        applicationId: w.appId,
        organizationId: w.orgId,
        endUserId: w.endUserId,
        role: 'MEMBER',
      });
      expect(r.isError).toBe(true);
      expect(r.data.error).toMatch(/write access/i);
    }
    expect(await membership(w.orgId, w.endUserId)).toBeNull();
  });

  it('write scope is not enough: a MEMBER is refused both writes', async () => {
    const memberCtx = {
      tenantUserId: 'tu_member',
      tenantId: 't_member',
      role: 'MEMBER' as const,
      scopes: UNRESTRICTED,
      canWrite: true,
      canAdmin: false,
    };
    const list = (await handleOperatorMcpMessage(memberCtx, { jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = list.result.tools.map((t) => t.name);
    for (const name of WRITE_TOOLS) {
      expect(names).not.toContain(name);
      const res = (await handleOperatorMcpMessage(memberCtx, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name, arguments: { applicationId: 'a', organizationId: 'o', endUserId: 'e', role: 'MEMBER' } },
      })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
      expect(res.result.isError).toBe(true);
      expect(JSON.parse(res.result.content[0]!.text).error).toMatch(/role/i);
    }
  });

  it('pages and searches organizations, so one past the first 100 is reachable', async () => {
    const w = await workspace('paging');
    await prisma.organization.createMany({
      data: Array.from({ length: 104 }, (_, i) => ({
        applicationId: w.appId,
        name: `Team ${String(i).padStart(3, '0')}`,
        slug: `team-${String(i).padStart(3, '0')}`,
      })),
    });

    const first = await call(w.token, 'list_organizations', { applicationId: w.appId });
    expect(first.data).toMatchObject({ total: 105, limit: 100, offset: 0, hasMore: true });
    expect((first.data.organizations as unknown[]).length).toBe(100);

    const rest = await call(w.token, 'list_organizations', { applicationId: w.appId, offset: 100 });
    expect(rest.data).toMatchObject({ total: 105, offset: 100, hasMore: false });
    expect((rest.data.organizations as unknown[]).length).toBe(5);

    const found = await call(w.token, 'list_organizations', { applicationId: w.appId, query: 'ACME' });
    expect(found.data).toMatchObject({ total: 1, organizations: [{ id: w.orgId }] });
    const bySlug = await call(w.token, 'list_organizations', { applicationId: w.appId, query: 'team-10' });
    expect(bySlug.data).toMatchObject({ total: 4, hasMore: false });
  });

  it('refuses malformed arguments instead of coercing them', async () => {
    const w = await workspace('args');
    const missing = await call(w.token, 'add_organization_member', {
      applicationId: w.appId,
      endUserId: w.endUserId,
    });
    expect(missing.isError).toBe(true);
    expect(missing.data).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(missing.data.error).toMatch(/organizationId/);

    const longRole = await call(w.token, 'add_organization_member', {
      applicationId: w.appId,
      organizationId: w.orgId,
      endUserId: w.endUserId,
      role: 'r'.repeat(41),
    });
    expect(longRole.isError).toBe(true);
    expect(longRole.data).toMatchObject({ code: 'VALIDATION_ERROR' });

    const extra = await call(w.token, 'set_organization_member_role', {
      applicationId: w.appId,
      organizationId: w.orgId,
      endUserId: w.endUserId,
      role: 'MEMBER',
      force: true,
    });
    expect(extra.data).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await membership(w.orgId, w.endUserId)).toBeNull();
  });

  it('annotates the tools so a client knows which ones change state', async () => {
    const w = await workspace('annotations');
    const res = await rpc(w.token, 'tools/list');
    const tools = res.json().result.tools as Array<{ name: string; annotations?: Record<string, boolean> }>;
    const by = (n: string) => tools.find((t) => t.name === n)?.annotations;
    expect(by('list_organizations')).toMatchObject({ readOnlyHint: true });
    expect(by('add_organization_member')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(by('set_organization_member_role')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it('the panel REST routes audit the same membership writes', async () => {
    const w = await workspace('rest-audit');
    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.appId}/organizations/${w.orgId}/members`,
      headers: { authorization: `Bearer ${w.accessToken}` },
      payload: { endUserId: w.endUserId, role: 'content-manager' },
    });
    expect(add.statusCode).toBe(201);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${w.appId}/organizations/${w.orgId}/members/${w.endUserId}`,
      headers: { authorization: `Bearer ${w.accessToken}` },
      payload: { role: 'MEMBER' },
    });
    expect(patch.statusCode).toBe(200);

    const [added] = await waitForSecurityEvents({ tenantId: w.tenantId, type: 'app.organization_member_added' });
    expect(added!.actorType).toBe('operator');
    expect(added!.applicationId).toBe(w.appId);
    expect(added!.metadata).toMatchObject({ organizationId: w.orgId, endUserId: w.endUserId, role: 'content-manager' });
    expect(added!.metadata).not.toHaveProperty('via');
    const [changed] = await waitForSecurityEvents({
      tenantId: w.tenantId,
      type: 'app.organization_member_role_changed',
    });
    expect(changed!.metadata).toMatchObject({ role: 'MEMBER', baseRole: 'MEMBER' });
  });

  describe('cross-tenant', () => {
    it("cannot reach another workspace's application", async () => {
      const victim = await workspace('victim-app');
      const attacker = await workspace('attacker-app');
      const writeArgs = {
        applicationId: victim.appId,
        organizationId: victim.orgId,
        endUserId: victim.endUserId,
        role: 'MEMBER',
      };
      for (const name of [...WRITE_TOOLS, 'list_organizations']) {
        const args = name === 'list_organizations' ? { applicationId: victim.appId } : writeArgs;
        const r = await call(attacker.token, name, args);
        expect(r.isError).toBe(true);
        expect(r.data).toMatchObject({ code: 'APPLICATION_NOT_FOUND' });
      }
      expect(await membership(victim.orgId, victim.endUserId)).toBeNull();
    });

    it("cannot aim its own application at another workspace's organization or end-user", async () => {
      const victim = await workspace('victim-ids');
      const attacker = await workspace('attacker-ids');

      const foreignOrg = await call(attacker.token, 'add_organization_member', {
        applicationId: attacker.appId,
        organizationId: victim.orgId,
        endUserId: attacker.endUserId,
        role: 'OWNER',
      });
      expect(foreignOrg.isError).toBe(true);
      expect(foreignOrg.data).toMatchObject({ code: 'ORGANIZATION_NOT_FOUND' });
      expect(foreignOrg.data.fix).toMatch(/list_organizations/);

      const foreignUser = await call(attacker.token, 'add_organization_member', {
        applicationId: attacker.appId,
        organizationId: attacker.orgId,
        endUserId: victim.endUserId,
        role: 'OWNER',
      });
      expect(foreignUser.isError).toBe(true);
      expect(foreignUser.data).toMatchObject({ code: 'END_USER_NOT_FOUND' });
      expect(foreignUser.data.fix).toMatch(/get_end_user/);

      await call(victim.token, 'add_organization_member', {
        applicationId: victim.appId,
        organizationId: victim.orgId,
        endUserId: victim.endUserId,
        role: 'MEMBER',
      });
      const demote = await call(attacker.token, 'set_organization_member_role', {
        applicationId: attacker.appId,
        organizationId: victim.orgId,
        endUserId: victim.endUserId,
        role: 'OWNER',
      });
      expect(demote.isError).toBe(true);
      expect(demote.data).toMatchObject({ code: 'ORGANIZATION_NOT_FOUND' });

      expect((await membership(victim.orgId, victim.endUserId))?.role).toBe('MEMBER');
      expect(await prisma.organizationMembership.count({ where: { organizationId: victim.orgId } })).toBe(1);
      expect(await prisma.organizationMembership.count({ where: { organizationId: attacker.orgId } })).toBe(0);
    });
  });
});
