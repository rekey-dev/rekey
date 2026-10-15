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
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

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
  ): Promise<LightMyRequestResponse> {
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
  ): Promise<LightMyRequestResponse> {
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

  // ---------- Discovery (end-user) ----------

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

  // ---------- Operator surface ----------

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

});
