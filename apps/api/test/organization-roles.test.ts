/**
 * Custom organization roles: the per-Application org role catalog.
 *
 * The property under test throughout: Rekey gates on a role's BASE TIER, never
 * on its name. A custom `content-manager` on tier MEMBER must be able to do
 * exactly what MEMBER can and nothing more, and every pre-existing invariant
 * (the canManage ladder, the last-OWNER guard) must keep holding once names
 * stop being a fixed enum.
 *
 * Coverage:
 *   - Every Application is seeded with the three built-ins.
 *   - Custom role creation: tier required, reserved names refused, orgs-enabled
 *     gate, built-ins immutable.
 *   - Assignment is ORG-authored: an OWNER hands out a custom role with their
 *     own end-user token, no operator involved.
 *   - The canManage ladder reads the tier: an ADMIN-tier custom role can manage
 *     members, a MEMBER-tier one cannot, regardless of what it is called.
 *   - The last-OWNER guard counts every OWNER-TIER name, not the literal
 *     'OWNER', so a custom owner-tier role still cannot be the last one demoted.
 *   - GET /users/me/organizations/roles lets an org admin discover the names.
 *   - /me carries the active org's role and tier next to the app-wide role.
 *   - Deleting a role in use refuses; reassignTo moves holders; an OWNER-tier
 *     role cannot be reassigned down a tier.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

interface Bootstrapped {
  applicationId: string;
  tenantAccess: string;
  liveKey: string;
  ownerAccess: string;
  ownerEndUserId: string;
}

describe('Custom organization roles', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string, opts?: { orgsEnabled?: boolean }): Promise<Bootstrapped> {
    const ts = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-orgrole-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${ts.accessToken}` },
        payload: { name: `App ${slug}`, slug: `orgrole-${slug}` },
      })
      .then((r) => r.json().data as { id: string });

    if (opts?.orgsEnabled !== false) {
      await prisma.application.update({
        where: { id: application.id },
        data: {
          authConfig: {
            methods: ['password'],
            passwordMinLength: 8,
            redirectUrls: [],
            organizationsEnabled: true,
            signupEnabled: true,
            passwordBreachCheckEnabled: false,
          } as never,
        },
      });
    }

    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ts.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${key.rawKey}` },
        payload: { email: `owner-orgrole-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });

    return {
      applicationId: application.id,
      tenantAccess: ts.accessToken,
      liveKey: key.rawKey,
      ownerAccess: eu.accessToken,
      ownerEndUserId: eu.endUser.id,
    };
  }

  async function createMember(
    b: Bootstrapped,
    email: string,
  ): Promise<{ access: string; id: string }> {
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
    return { access: eu.accessToken, id: eu.endUser.id };
  }

  /** Operator-side catalog write (tenant JWT). */
  function defineRole(
    b: Bootstrapped,
    payload: Record<string, unknown>,
  ): ReturnType<FastifyInstance['inject']> {
    return app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload,
    });
  }

  /** End-user-side org call (publishable/secret key + the user's own JWT). */
  function asUser(
    b: Bootstrapped,
    userToken: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ): ReturnType<FastifyInstance['inject']> {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-rekey-user-token': userToken },
      ...(payload !== undefined && { payload }),
    });
  }

  async function makeOrg(b: Bootstrapped, slug: string): Promise<string> {
    const res = await asUser(b, b.ownerAccess, 'POST', '/api/v1/users/me/organizations/', {
      name: `Org ${slug}`,
      slug,
    });
    return (res.json().data as { organization: { id: string } }).organization.id;
  }

  // ---------- Catalog bootstrap ----------

  it('seeds OWNER / ADMIN / MEMBER on every new Application, with MEMBER default', async () => {
    const b = await bootstrap('seed');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(res.statusCode).toBe(200);
    const roles = res.json().data as Array<{
      name: string;
      baseRole: string;
      isBuiltIn: boolean;
      isDefault: boolean;
    }>;
    expect(roles.map((r) => r.name).sort()).toEqual(['ADMIN', 'MEMBER', 'OWNER']);
    expect(roles.every((r) => r.isBuiltIn)).toBe(true);
    // Each built-in sits on its own tier. That identity is what keeps every
    // pre-catalog membership row resolving to the authority it always had.
    for (const r of roles) expect(r.baseRole).toBe(r.name);
    expect(roles.find((r) => r.isDefault)?.name).toBe('MEMBER');
  });

  // ---------- Catalog authoring (operator) ----------

  it('refuses custom roles while organizations are disabled, and names the toggle', async () => {
    const b = await bootstrap('disabled', { orgsEnabled: false });
    const res = await defineRole(b, { name: 'content-manager', baseRole: 'MEMBER' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ORGANIZATIONS_NOT_ENABLED');
    // The refusal has to be actionable, since it is also what the panel and the
    // MCP tool turn into an "enable organizations" prompt.
    expect(res.json().error.fix).toMatch(/organizationsEnabled/);
  });

  it('reads the catalog even while organizations are disabled', async () => {
    const b = await bootstrap('read-disabled', { orgsEnabled: false });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as unknown[]).length).toBe(3);
  });

  it('reserves the built-in names and rejects non-lowercase custom names', async () => {
    const b = await bootstrap('names');
    const reserved = await defineRole(b, { name: 'owner', baseRole: 'OWNER' });
    expect(reserved.statusCode).toBe(409);
    expect(reserved.json().error.code).toBe('ORGANIZATION_ROLE_NAME_RESERVED');

    const shouty = await defineRole(b, { name: 'Content_Manager', baseRole: 'MEMBER' });
    expect(shouty.statusCode).toBe(400);
    expect(shouty.json().error.code).toBe('ORGANIZATION_ROLE_NAME_INVALID');
  });

  it('refuses to re-tier a built-in role', async () => {
    const b = await bootstrap('retier');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/OWNER`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { baseRole: 'MEMBER' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ORGANIZATION_ROLE_BUILT_IN_IMMUTABLE');
  });

  // ---------- Discovery (end-user) ----------

  it('lets a signed-in end-user list the assignable role names', async () => {
    const b = await bootstrap('discover');
    await defineRole(b, {
      name: 'content-manager',
      baseRole: 'MEMBER',
      description: 'Drafts and edits content',
    });
    const res = await asUser(b, b.ownerAccess, 'GET', '/api/v1/users/me/organizations/roles');
    expect(res.statusCode).toBe(200);
    const roles = res.json().data as Array<{ name: string; baseRole: string }>;
    // Without this an org admin's UI could not populate a role picker: the only
    // other way to learn a custom name would be to guess it.
    expect(roles.find((r) => r.name === 'content-manager')?.baseRole).toBe('MEMBER');
  });

  // ---------- Assignment is org-authored, not operator-authored ----------

  it('an org OWNER assigns a custom role with their OWN token, no operator involved', async () => {
    const b = await bootstrap('assign');
    await defineRole(b, { name: 'content-manager', baseRole: 'MEMBER' });
    const orgId = await makeOrg(b, 'assign-org');
    const member = await createMember(b, 'assignee-orgrole@example.com');

    // Join at the default role first, via an invite the OWNER issues.
    const invite = await asUser(
      b,
      b.ownerAccess,
      'POST',
      `/api/v1/users/me/organizations/${orgId}/invitations`,
      { email: 'assignee-orgrole@example.com', role: 'MEMBER' },
    );
    expect(invite.statusCode).toBe(201);
    const token = (invite.json().data as { token: string }).token;
    const accepted = await asUser(
      b,
      member.access,
      'POST',
      '/api/v1/auth/organizations/accept-invitation',
      { token },
    );
    expect(accepted.statusCode).toBe(200);

    // Now the OWNER re-roles them to the custom name. Tenant JWT never used.
    const res = await asUser(
      b,
      b.ownerAccess,
      'PATCH',
      `/api/v1/users/me/organizations/${orgId}/members/${member.id}`,
      { role: 'content-manager' },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json().data as { role: string; baseRole: string };
    expect(body.role).toBe('content-manager');
    expect(body.baseRole).toBe('MEMBER');
  });

  it('refuses assignment of a role name that is not in the catalog', async () => {
    const b = await bootstrap('unknown');
    const orgId = await makeOrg(b, 'unknown-org');
    const member = await createMember(b, 'unknown-orgrole@example.com');
    await prisma.organizationMembership.create({
      data: { organizationId: orgId, endUserId: member.id, role: 'MEMBER' },
    });
    const res = await asUser(
      b,
      b.ownerAccess,
      'PATCH',
      `/api/v1/users/me/organizations/${orgId}/members/${member.id}`,
      { role: 'not-a-real-role' },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ORGANIZATION_ROLE_UNKNOWN');
  });

  it('an invitation that omits a role lands on the catalog default', async () => {
    const b = await bootstrap('invite-default');
    // Make a custom role the default, so a pass would be indistinguishable from
    // hardcoding 'MEMBER' if we left the built-in default in place.
    await defineRole(b, { name: 'contributor', baseRole: 'MEMBER', isDefault: true });
    const orgId = await makeOrg(b, 'invite-default-org');
    const invitee = await createMember(b, 'default-invitee@example.com');

    const inv = await asUser(
      b,
      b.ownerAccess,
      'POST',
      `/api/v1/users/me/organizations/${orgId}/invitations`,
      { email: 'default-invitee@example.com' },
    );
    if (inv.statusCode !== 201) console.error('INVITE FAIL BODY:', inv.body);
    expect(inv.statusCode).toBe(201);
    const { token, invitation } = inv.json().data as {
      token: string;
      invitation: { role: string };
    };
    expect(invitation.role).toBe('contributor');

    const accepted = await asUser(
      b,
      invitee.access,
      'POST',
      '/api/v1/auth/organizations/accept-invitation',
      { token },
    );
    expect(accepted.statusCode).toBe(200);
    const membership = (accepted.json().data as { membership: { role: string; baseRole: string } })
      .membership;
    expect(membership.role).toBe('contributor');
    expect(membership.baseRole).toBe('MEMBER');
  });

  // ---------- The ladder reads the TIER, not the name ----------

  it('a MEMBER-tier custom role cannot manage members; an ADMIN-tier one can', async () => {
    const b = await bootstrap('ladder');
    await defineRole(b, { name: 'content-manager', baseRole: 'MEMBER' });
    await defineRole(b, { name: 'studio-lead', baseRole: 'ADMIN' });
    const orgId = await makeOrg(b, 'ladder-org');

    const cm = await createMember(b, 'cm-ladder@example.com');
    const lead = await createMember(b, 'lead-ladder@example.com');
    const victim = await createMember(b, 'victim-ladder@example.com');
    await prisma.organizationMembership.createMany({
      data: [
        { organizationId: orgId, endUserId: cm.id, role: 'content-manager' },
        { organizationId: orgId, endUserId: lead.id, role: 'studio-lead' },
        { organizationId: orgId, endUserId: victim.id, role: 'MEMBER' },
      ],
    });

    // MEMBER tier, refused however senior the word sounds.
    const denied = await asUser(
      b,
      cm.access,
      'PATCH',
      `/api/v1/users/me/organizations/${orgId}/members/${victim.id}`,
      { role: 'content-manager' },
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('ORGANIZATION_ROLE_INSUFFICIENT');

    // ADMIN tier, allowed however junior the word sounds.
    const allowed = await asUser(
      b,
      lead.access,
      'PATCH',
      `/api/v1/users/me/organizations/${orgId}/members/${victim.id}`,
      { role: 'content-manager' },
    );
    expect(allowed.statusCode).toBe(200);
    expect((allowed.json().data as { baseRole: string }).baseRole).toBe('MEMBER');
  });

  it('an ADMIN-tier custom role still cannot touch an OWNER', async () => {
    const b = await bootstrap('ladder-owner');
    await defineRole(b, { name: 'studio-lead', baseRole: 'ADMIN' });
    const orgId = await makeOrg(b, 'ladder-owner-org');
    const lead = await createMember(b, 'lead-owner@example.com');
    await prisma.organizationMembership.create({
      data: { organizationId: orgId, endUserId: lead.id, role: 'studio-lead' },
    });
    const res = await asUser(
      b,
      lead.access,
      'PATCH',
      `/api/v1/users/me/organizations/${orgId}/members/${b.ownerEndUserId}`,
      { role: 'MEMBER' },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ORGANIZATION_ROLE_INSUFFICIENT');
  });

  // ---------- Last-OWNER guard across custom owner-tier names ----------

  it('the last-OWNER guard counts every OWNER-TIER name, not the literal OWNER', async () => {
    const b = await bootstrap('lastowner');
    await defineRole(b, { name: 'founder', baseRole: 'OWNER' });
    const orgId = await makeOrg(b, 'lastowner-org');

    // Move the sole owner onto the custom OWNER-tier name. If the guard only
    // counted role='OWNER' it would now see zero owners and allow the demotion,
    // leaving the organization ownerless.
    await prisma.organizationMembership.update({
      where: { organizationId_endUserId: { organizationId: orgId, endUserId: b.ownerEndUserId } },
      data: { role: 'founder' },
    });

    const res = await asUser(
      b,
      b.ownerAccess,
      'PATCH',
      `/api/v1/users/me/organizations/${orgId}/members/${b.ownerEndUserId}`,
      { role: 'MEMBER' },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ORGANIZATION_LAST_OWNER');
  });

  // ---------- /me carries the org-scoped role ----------

  it('/me reports the active org role + tier alongside the app-wide role', async () => {
    const b = await bootstrap('me');
    await defineRole(b, { name: 'content-manager', baseRole: 'MEMBER' });
    const orgId = await makeOrg(b, 'me-org');
    await prisma.organizationMembership.update({
      where: { organizationId_endUserId: { organizationId: orgId, endUserId: b.ownerEndUserId } },
      data: { role: 'content-manager' },
    });

    const switched = await asUser(
      b,
      b.ownerAccess,
      'POST',
      `/api/v1/users/me/organizations/${orgId}/switch`,
    );
    expect(switched.statusCode).toBe(200);
    const access = (switched.json().data as { accessToken: string }).accessToken;

    const me = await app
      .inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { 'x-rekey-user-token': access },
      })
      .then((r) => r.json().data as Record<string, unknown>);

    expect(me.activeOrganizationId).toBe(orgId);
    expect(me.activeOrganizationRole).toBe('content-manager');
    expect(me.activeOrganizationBaseRole).toBe('MEMBER');
    // The whole point of the pairing: the app-wide role is a DIFFERENT value,
    // and an integrator reading `role` after an org switch was getting this one.
    expect(me.role).toBe('user');
  });

  it('/me nulls the org role when there is no active organization', async () => {
    const b = await bootstrap('me-null');
    const me = await app
      .inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { 'x-rekey-user-token': b.ownerAccess },
      })
      .then((r) => r.json().data as Record<string, unknown>);
    expect(me.activeOrganizationId).toBeNull();
    expect(me.activeOrganizationRole).toBeNull();
    expect(me.activeOrganizationBaseRole).toBeNull();
  });

  // ---------- Operator surface ----------

  it('an operator can assign a custom role through the tenant routes', async () => {
    const b = await bootstrap('operator-assign');
    await defineRole(b, { name: 'content-manager', baseRole: 'MEMBER' });
    const orgId = await makeOrg(b, 'operator-assign-org');
    const member = await createMember(b, 'op-assign@example.com');

    // The route-level body schema kept the old 3-value enum after the catalog
    // landed, so Ajv rejected every custom name before the handler ran and the
    // operator surface could not do what the end-user surface could.
    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/organizations/${orgId}/members`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { endUserId: member.id, role: 'content-manager' },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().data).toMatchObject({ role: 'content-manager', baseRole: 'MEMBER' });

    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/organizations/${orgId}/members/${member.id}`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { role: 'ADMIN' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().data).toMatchObject({ role: 'ADMIN', baseRole: 'ADMIN' });
  });

  it('an operator assigning an unknown role name gets ORGANIZATION_ROLE_UNKNOWN, not a schema error', async () => {
    const b = await bootstrap('operator-unknown');
    const orgId = await makeOrg(b, 'operator-unknown-org');
    const member = await createMember(b, 'op-unknown@example.com');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/organizations/${orgId}/members`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { endUserId: member.id, role: 'not-a-real-role' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ORGANIZATION_ROLE_UNKNOWN');
  });

  it('an operator add-member that omits the role uses the catalog default', async () => {
    const b = await bootstrap('operator-default');
    await defineRole(b, { name: 'contributor', baseRole: 'MEMBER', isDefault: true });
    const orgId = await makeOrg(b, 'operator-default-org');
    const member = await createMember(b, 'op-default@example.com');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/organizations/${orgId}/members`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { endUserId: member.id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ role: 'contributor', baseRole: 'MEMBER' });
  });

  // ---------- Re-tiering ----------

  it('refuses to move a custom role off the OWNER tier when that would orphan an org', async () => {
    const b = await bootstrap('retier-orphan');
    await defineRole(b, { name: 'founder', baseRole: 'OWNER' });
    const orgId = await makeOrg(b, 'retier-orphan-org');
    await prisma.organizationMembership.update({
      where: { organizationId_endUserId: { organizationId: orgId, endUserId: b.ownerEndUserId } },
      data: { role: 'founder' },
    });

    // No membership row is touched by a re-tier, so the per-member last-OWNER
    // guard never runs. Without this check the organization is left with nobody
    // who can manage members or authorize an org-scoped billing write.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/founder`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { baseRole: 'MEMBER' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ORGANIZATION_ROLE_RETIER_ORPHANS_OWNERS');

    const still = await prisma.organizationRoleDef.findUniqueOrThrow({
      where: { applicationId_name: { applicationId: b.applicationId, name: 'founder' } },
    });
    expect(still.baseRole).toBe('OWNER');
  });

  it('allows the same re-tier once another OWNER-tier member exists', async () => {
    const b = await bootstrap('retier-ok');
    await defineRole(b, { name: 'founder', baseRole: 'OWNER' });
    const orgId = await makeOrg(b, 'retier-ok-org');
    await prisma.organizationMembership.update({
      where: { organizationId_endUserId: { organizationId: orgId, endUserId: b.ownerEndUserId } },
      data: { role: 'founder' },
    });
    const coOwner = await createMember(b, 'co-owner-retier@example.com');
    await prisma.organizationMembership.create({
      data: { organizationId: orgId, endUserId: coOwner.id, role: 'OWNER' },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/founder`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { baseRole: 'MEMBER' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.baseRole).toBe('MEMBER');
  });

  it('re-tiering a role no organization uses is unaffected by the guard', async () => {
    const b = await bootstrap('retier-unused');
    await defineRole(b, { name: 'founder', baseRole: 'OWNER' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/founder`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { baseRole: 'ADMIN' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.baseRole).toBe('ADMIN');
  });

  // ---------- Concurrency ----------

  it('two concurrent demotions cannot both pass the last-OWNER guard', async () => {
    const b = await bootstrap('race');
    const orgId = await makeOrg(b, 'race-org');
    const second = await createMember(b, 'co-owner-race@example.com');
    await prisma.organizationMembership.create({
      data: { organizationId: orgId, endUserId: second.id, role: 'OWNER' },
    });

    // Exactly two owners. Demote both at once: each request counts the owners
    // and then writes, so without a lock both read 2, both pass the guard, and
    // the organization ends up with zero owners.
    const [a, c] = await Promise.all([
      asUser(b, b.ownerAccess, 'PATCH', `/api/v1/users/me/organizations/${orgId}/members/${second.id}`, {
        role: 'MEMBER',
      }),
      asUser(b, second.access, 'PATCH', `/api/v1/users/me/organizations/${orgId}/members/${b.ownerEndUserId}`, {
        role: 'MEMBER',
      }),
    ]);

    const owners = await prisma.organizationMembership.count({
      where: { organizationId: orgId, role: 'OWNER' },
    });
    // The invariant, stated directly: whatever the two requests did, the
    // organization still has an owner.
    expect(owners).toBeGreaterThanOrEqual(1);
    // And exactly one of them was refused for the right reason.
    const codes = [a, c].map((r) => (r.statusCode === 200 ? 'ok' : r.json().error.code));
    expect(codes.filter((x) => x === 'ok')).toHaveLength(1);
    expect(codes).toContain('ORGANIZATION_LAST_OWNER');
  });

  it('a concurrent demotion and removal cannot both drop the last owner', async () => {
    const b = await bootstrap('race2');
    const orgId = await makeOrg(b, 'race2-org');
    const second = await createMember(b, 'co-owner-race2@example.com');
    await prisma.organizationMembership.create({
      data: { organizationId: orgId, endUserId: second.id, role: 'OWNER' },
    });

    const [a, c] = await Promise.all([
      asUser(b, b.ownerAccess, 'PATCH', `/api/v1/users/me/organizations/${orgId}/members/${second.id}`, {
        role: 'MEMBER',
      }),
      asUser(b, second.access, 'DELETE', `/api/v1/users/me/organizations/${orgId}/members/${b.ownerEndUserId}`),
    ]);

    const owners = await prisma.organizationMembership.count({
      where: { organizationId: orgId, role: 'OWNER' },
    });
    expect(owners).toBeGreaterThanOrEqual(1);
    const outcomes = [a, c].map((r) => (r.statusCode < 300 ? 'ok' : r.json().error.code));
    expect(outcomes).toContain('ORGANIZATION_LAST_OWNER');
  });

  // ---------- Catalog cache ----------

  it('a tier change takes effect on the very next request', async () => {
    const b = await bootstrap('cache');
    await defineRole(b, { name: 'studio-lead', baseRole: 'ADMIN' });
    const orgId = await makeOrg(b, 'cache-org');
    const lead = await createMember(b, 'lead-cache@example.com');
    const victim = await createMember(b, 'victim-cache@example.com');
    await prisma.organizationMembership.createMany({
      data: [
        { organizationId: orgId, endUserId: lead.id, role: 'studio-lead' },
        { organizationId: orgId, endUserId: victim.id, role: 'MEMBER' },
      ],
    });

    // Warm the cache with the ADMIN tier by exercising a gated path.
    const before = await asUser(
      b,
      lead.access,
      'PATCH',
      `/api/v1/users/me/organizations/${orgId}/members/${victim.id}`,
      { role: 'MEMBER' },
    );
    expect(before.statusCode).toBe(200);

    // Demote the ROLE, not the member. Writes invalidate, so the next request
    // must see MEMBER rather than serving the cached ADMIN for a TTL.
    const retier = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/studio-lead`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { baseRole: 'MEMBER' },
    });
    expect(retier.statusCode).toBe(200);

    const after = await asUser(
      b,
      lead.access,
      'PATCH',
      `/api/v1/users/me/organizations/${orgId}/members/${victim.id}`,
      { role: 'MEMBER' },
    );
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe('ORGANIZATION_ROLE_INSUFFICIENT');
  });

  it('a newly created role is assignable immediately', async () => {
    const b = await bootstrap('cache-create');
    const orgId = await makeOrg(b, 'cache-create-org');
    const member = await createMember(b, 'fresh-cache@example.com');
    await prisma.organizationMembership.create({
      data: { organizationId: orgId, endUserId: member.id, role: 'MEMBER' },
    });
    // Warm the cache before the role exists, so a stale snapshot would 400.
    const warm = await asUser(b, b.ownerAccess, 'GET', '/api/v1/users/me/organizations/roles');
    expect(warm.statusCode).toBe(200);

    await defineRole(b, { name: 'fresh-role', baseRole: 'MEMBER' });

    const res = await asUser(
      b,
      b.ownerAccess,
      'PATCH',
      `/api/v1/users/me/organizations/${orgId}/members/${member.id}`,
      { role: 'fresh-role' },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().data.role).toBe('fresh-role');
  });

  // ---------- Disabling a role (revocation) ----------

  it('disabling a role refuses its existing holders, without touching the membership', async () => {
    const b = await bootstrap('disable');
    await defineRole(b, { name: 'studio-lead', baseRole: 'ADMIN' });
    const orgId = await makeOrg(b, 'disable-org');
    const lead = await createMember(b, 'lead-disable@example.com');
    await prisma.organizationMembership.create({
      data: { organizationId: orgId, endUserId: lead.id, role: 'studio-lead' },
    });

    // Works before.
    expect(
      (await asUser(b, lead.access, 'GET', `/api/v1/users/me/organizations/${orgId}`)).statusCode,
    ).toBe(200);

    const off = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/studio-lead`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { disabled: true },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().data.disabled).toBe(true);

    // Refused out loud, not silently degraded to MEMBER.
    const after = await asUser(b, lead.access, 'GET', `/api/v1/users/me/organizations/${orgId}`);
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe('ORGANIZATION_ROLE_DISABLED');

    // The membership survives, so re-enabling restores them rather than
    // requiring someone to re-invite.
    const row = await prisma.organizationMembership.findUniqueOrThrow({
      where: { organizationId_endUserId: { organizationId: orgId, endUserId: lead.id } },
    });
    expect(row.role).toBe('studio-lead');
  });

  it('re-enabling restores the holder', async () => {
    const b = await bootstrap('reenable');
    await defineRole(b, { name: 'studio-lead', baseRole: 'ADMIN' });
    const orgId = await makeOrg(b, 'reenable-org');
    const lead = await createMember(b, 'lead-reenable@example.com');
    await prisma.organizationMembership.create({
      data: { organizationId: orgId, endUserId: lead.id, role: 'studio-lead' },
    });
    const patch = (disabled: boolean): ReturnType<FastifyInstance['inject']> =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/studio-lead`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: { disabled },
      });

    await patch(true);
    expect(
      (await asUser(b, lead.access, 'GET', `/api/v1/users/me/organizations/${orgId}`)).statusCode,
    ).toBe(403);
    await patch(false);
    expect(
      (await asUser(b, lead.access, 'GET', `/api/v1/users/me/organizations/${orgId}`)).statusCode,
    ).toBe(200);
  });

  it('a disabled role cannot be newly assigned', async () => {
    const b = await bootstrap('disable-assign');
    await defineRole(b, { name: 'content-manager', baseRole: 'MEMBER' });
    const orgId = await makeOrg(b, 'disable-assign-org');
    const member = await createMember(b, 'assignee-disable@example.com');
    await prisma.organizationMembership.create({
      data: { organizationId: orgId, endUserId: member.id, role: 'MEMBER' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/content-manager`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { disabled: true },
    });

    const res = await asUser(
      b,
      b.ownerAccess,
      'PATCH',
      `/api/v1/users/me/organizations/${orgId}/members/${member.id}`,
      { role: 'content-manager' },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ORGANIZATION_ROLE_DISABLED');
  });

  it('refuses to disable an OWNER-tier role that is an org\'s only route to an owner', async () => {
    const b = await bootstrap('disable-owner');
    await defineRole(b, { name: 'founder', baseRole: 'OWNER' });
    const orgId = await makeOrg(b, 'disable-owner-org');
    await prisma.organizationMembership.update({
      where: { organizationId_endUserId: { organizationId: orgId, endUserId: b.ownerEndUserId } },
      data: { role: 'founder' },
    });

    // Same stranding as a downward re-tier, through a different door.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/founder`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { disabled: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ORGANIZATION_ROLE_RETIER_ORPHANS_OWNERS');
  });

  it('a disabled role does not count as an owner for the last-owner guard', async () => {
    const b = await bootstrap('disable-count');
    await defineRole(b, { name: 'founder', baseRole: 'OWNER' });
    const orgId = await makeOrg(b, 'disable-count-org');
    const co = await createMember(b, 'co-disable@example.com');
    await prisma.organizationMembership.create({
      data: { organizationId: orgId, endUserId: co.id, role: 'founder' },
    });
    // Two owner-tier members: the built-in OWNER and a `founder`. Disabling
    // `founder` is allowed, because the built-in OWNER still covers the org.
    const off = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/founder`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { disabled: true },
    });
    expect(off.statusCode).toBe(200);

    // Now the remaining OWNER is the only usable one, so demoting them is
    // refused: the disabled `founder` must not be counted as a second owner.
    const res = await asUser(
      b,
      b.ownerAccess,
      'PATCH',
      `/api/v1/users/me/organizations/${orgId}/members/${b.ownerEndUserId}`,
      { role: 'MEMBER' },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ORGANIZATION_LAST_OWNER');
  });

  // ---------- Deletion ----------

  it('refuses to delete a role in use, then reassigns holders when told to', async () => {
    const b = await bootstrap('delete');
    await defineRole(b, { name: 'content-manager', baseRole: 'MEMBER' });
    const orgId = await makeOrg(b, 'delete-org');
    const member = await createMember(b, 'del-orgrole@example.com');
    await prisma.organizationMembership.create({
      data: { organizationId: orgId, endUserId: member.id, role: 'content-manager' },
    });

    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/content-manager`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe('ORGANIZATION_ROLE_IN_USE');

    const done = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/content-manager?reassignTo=MEMBER`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().data).toMatchObject({ removed: true, reassignedMemberships: 1 });

    const after = await prisma.organizationMembership.findUniqueOrThrow({
      where: { organizationId_endUserId: { organizationId: orgId, endUserId: member.id } },
    });
    expect(after.role).toBe('MEMBER');
  });

  it('refuses to reassign an OWNER-tier role down a tier', async () => {
    const b = await bootstrap('demote');
    await defineRole(b, { name: 'founder', baseRole: 'OWNER' });
    const orgId = await makeOrg(b, 'demote-org');
    await prisma.organizationMembership.update({
      where: { organizationId_endUserId: { organizationId: orgId, endUserId: b.ownerEndUserId } },
      data: { role: 'founder' },
    });

    // The per-member last-OWNER guard does not sit on this path, so without an
    // explicit refusal a bulk reassign would quietly empty every organization
    // of its owner.
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/founder?reassignTo=MEMBER`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ORGANIZATION_ROLE_REASSIGN_DEMOTES_OWNER');
  });

  it('refuses to delete a built-in role', async () => {
    const b = await bootstrap('builtin-del');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/organization-roles/MEMBER`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ORGANIZATION_ROLE_BUILT_IN_IMMUTABLE');
  });
});
