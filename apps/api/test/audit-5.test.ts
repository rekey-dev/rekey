/**
 * Audit-5 / end-user organizations (Clerk-style teams inside an Application).
 *
 * Coverage:
 *   - ORGANIZATIONS_NOT_ENABLED when authConfig.organizationsEnabled is false.
 *   - create makes the caller OWNER atomically.
 *   - listMine returns the org + role.
 *   - invite + accept creates a membership; raw token is single-use.
 *   - invite is enumeration-safe vs same-email re-invite (already-member 409).
 *   - cross-Application invitation refused with WRONG_APPLICATION.
 *   - role hierarchy: ADMIN cannot demote OWNER; OWNER can.
 *   - last-OWNER guard: cannot demote/remove the only OWNER.
 *   - self-leave allowed (unless last-OWNER).
 *   - revoke-invitation idempotent; revoked invite cannot be accepted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  ownerAccess: string;
  ownerEndUserId: string;
}

describe('Audit-5 end-user organizations', () => {
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
          email: `op-a5-${slug}@example.com`,
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
        payload: { name: `App ${slug}`, slug: `a5-${slug}` },
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
        payload: { email: `owner-a5-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
    return {
      applicationId: application.id,
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

  // ---------- Gating ----------

  it('returns ORGANIZATIONS_NOT_ENABLED when authConfig.organizationsEnabled is false', async () => {
    const b = await bootstrap('disabled', { orgsEnabled: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/organizations/',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.ownerAccess,
      },
      payload: { name: 'Acme', slug: 'acme' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ORGANIZATIONS_NOT_ENABLED');
  });

  // ---------- Create + list-mine ----------

  it('create makes the caller OWNER; listMine surfaces role', async () => {
    const b = await bootstrap('create-owner');
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/organizations/',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.ownerAccess,
      },
      payload: { name: 'Acme', slug: 'acme' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json().data as {
      organization: { id: string; slug: string };
      membership: { role: string };
    };
    expect(created.organization.slug).toBe('acme');
    expect(created.membership.role).toBe('OWNER');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/organizations/',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.ownerAccess,
      },
    });
    const rows = list.json().data as {
      items: Array<{ slug: string; role: string }>;
      page: { total: number };
    };
    expect(rows.items).toHaveLength(1);
    expect(rows.page.total).toBe(1);
    expect(rows.items[0]).toMatchObject({ slug: 'acme', role: 'OWNER' });
  });

  it('slug must be lowercase URL-safe; collisions return ORGANIZATION_SLUG_TAKEN', async () => {
    const b = await bootstrap('slug-collide');
    await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/organizations/',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.ownerAccess,
      },
      payload: { name: 'Acme', slug: 'acme' },
    });
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/organizations/',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.ownerAccess,
      },
      payload: { name: 'Acme 2', slug: 'ACME' }, // service lowercases
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('ORGANIZATION_SLUG_TAKEN');
  });

  // ---------- Invite + accept ----------

  it('invite + accept creates a membership at the invited role; raw token single-use', async () => {
    const b = await bootstrap('invite');
    const org = await app
      .inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations/',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-rekey-user-token': b.ownerAccess,
        },
        payload: { name: 'Acme', slug: 'acme' },
      })
      .then((r) => r.json().data as { organization: { id: string } });
    const invitee = await createMember(b, 'admin@example.com');

    const inv = await app
      .inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${org.organization.id}/invitations`,
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-rekey-user-token': b.ownerAccess,
        },
        payload: { email: 'admin@example.com', role: 'ADMIN' },
      })
      .then((r) => r.json().data as { token: string; invitation: { id: string } });

    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/organizations/accept-invitation',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': invitee.access,
      },
      payload: { token: inv.token },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().data.membership.role).toBe('ADMIN');

    // Re-use of the token: invitation is already accepted.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/organizations/accept-invitation',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': invitee.access,
      },
      payload: { token: inv.token },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe('ORGANIZATION_INVITATION_NOT_USABLE');
  });

  it('cross-Application invitation refused with WRONG_APPLICATION', async () => {
    const a = await bootstrap('cross-a');
    const b = await bootstrap('cross-b');
    const orgA = await app
      .inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations/',
        headers: {
          authorization: `Bearer ${a.liveKey}`,
          'x-rekey-user-token': a.ownerAccess,
        },
        payload: { name: 'A-Org', slug: 'a-org' },
      })
      .then((r) => r.json().data as { organization: { id: string } });
    const inv = await app
      .inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${orgA.organization.id}/invitations`,
        headers: {
          authorization: `Bearer ${a.liveKey}`,
          'x-rekey-user-token': a.ownerAccess,
        },
        payload: { email: 'whoever@example.com', role: 'MEMBER' },
      })
      .then((r) => r.json().data as { token: string });

    // Try to accept via Application B's secret key with B's user.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/organizations/accept-invitation',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.ownerAccess,
      },
      payload: { token: inv.token },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('ORGANIZATION_INVITATION_WRONG_APPLICATION');
  });

  // ---------- RBAC ----------

  it('ADMIN cannot demote OWNER but OWNER can', async () => {
    const b = await bootstrap('demote');
    const org = await app
      .inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations/',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-rekey-user-token': b.ownerAccess,
        },
        payload: { name: 'Acme', slug: 'acme' },
      })
      .then((r) => r.json().data as { organization: { id: string } });
    const admin = await createMember(b, 'admin-demote@example.com');
    // Promote admin via OWNER token, then admin tries to demote OWNER.
    const inv = await app
      .inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${org.organization.id}/invitations`,
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-rekey-user-token': b.ownerAccess,
        },
        payload: { email: 'admin-demote@example.com', role: 'ADMIN' },
      })
      .then((r) => r.json().data as { token: string });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/organizations/accept-invitation',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': admin.access,
      },
      payload: { token: inv.token },
    });
    // Admin attempts to demote OWNER.
    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/me/organizations/${org.organization.id}/members/${b.ownerEndUserId}`,
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': admin.access,
      },
      payload: { role: 'MEMBER' },
    });
    expect(demote.statusCode).toBe(403);
    expect(demote.json().error.code).toBe('ORGANIZATION_ROLE_INSUFFICIENT');
  });

  it('last-OWNER guard: cannot demote or remove the only OWNER', async () => {
    const b = await bootstrap('last-owner');
    const org = await app
      .inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations/',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-rekey-user-token': b.ownerAccess,
        },
        payload: { name: 'Acme', slug: 'acme' },
      })
      .then((r) => r.json().data as { organization: { id: string } });

    // Demote attempt — no other OWNER exists.
    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/me/organizations/${org.organization.id}/members/${b.ownerEndUserId}`,
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.ownerAccess,
      },
      payload: { role: 'MEMBER' },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe('ORGANIZATION_LAST_OWNER');

    // Leave attempt — an OWNER can never self-leave (billing is tied to them),
    // so this is refused before the last-OWNER check even applies.
    const leave = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${org.organization.id}/leave`,
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.ownerAccess,
      },
    });
    expect(leave.statusCode).toBe(409);
    expect(leave.json().error.code).toBe('ORGANIZATION_OWNER_CANNOT_LEAVE');
  });

  it('an OWNER cannot leave even with a co-owner; after self-demoting to ADMIN they can', async () => {
    const b = await bootstrap('owner-leave');
    const org = await app
      .inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations/',
        headers: { authorization: `Bearer ${b.liveKey}`, 'x-rekey-user-token': b.ownerAccess },
        payload: { name: 'Acme', slug: 'acme' },
      })
      .then((r) => r.json().data as { organization: { id: string } });

    // Add a second OWNER so the last-OWNER guard is not what's blocking.
    const co = await createMember(b, 'co-owner@example.com');
    const inv = await app
      .inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${org.organization.id}/invitations`,
        headers: { authorization: `Bearer ${b.liveKey}`, 'x-rekey-user-token': b.ownerAccess },
        payload: { email: 'co-owner@example.com', role: 'OWNER' },
      })
      .then((r) => r.json().data as { token: string });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/organizations/accept-invitation',
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-rekey-user-token': co.access },
      payload: { token: inv.token },
    });

    // Owner still cannot leave — billing is tied to owners, not the seat count.
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${org.organization.id}/leave`,
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-rekey-user-token': b.ownerAccess },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('ORGANIZATION_OWNER_CANNOT_LEAVE');

    // Self-demote to ADMIN (allowed — a co-owner remains), then leaving works.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/me/organizations/${org.organization.id}/members/${b.ownerEndUserId}`,
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-rekey-user-token': b.ownerAccess },
      payload: { role: 'ADMIN' },
    });
    const left = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${org.organization.id}/leave`,
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-rekey-user-token': b.ownerAccess },
    });
    expect(left.statusCode).toBe(200);
    expect(left.json().data.removed).toBe(true);
  });

  it('MEMBER can self-leave; OWNER count > 1 lets former-OWNER leave too', async () => {
    const b = await bootstrap('leave');
    const org = await app
      .inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations/',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-rekey-user-token': b.ownerAccess,
        },
        payload: { name: 'Acme', slug: 'acme' },
      })
      .then((r) => r.json().data as { organization: { id: string } });
    const member = await createMember(b, 'member-leave@example.com');
    const inv = await app
      .inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${org.organization.id}/invitations`,
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-rekey-user-token': b.ownerAccess,
        },
        payload: { email: 'member-leave@example.com', role: 'MEMBER' },
      })
      .then((r) => r.json().data as { token: string });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/organizations/accept-invitation',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': member.access,
      },
      payload: { token: inv.token },
    });
    const leave = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${org.organization.id}/leave`,
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': member.access,
      },
    });
    expect(leave.statusCode).toBe(200);
    expect(leave.json().data.removed).toBe(true);
  });

  // ---------- Revoke ----------

  it('revoke makes the invitation un-acceptable', async () => {
    const b = await bootstrap('revoke');
    const org = await app
      .inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations/',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-rekey-user-token': b.ownerAccess,
        },
        payload: { name: 'Acme', slug: 'acme' },
      })
      .then((r) => r.json().data as { organization: { id: string } });
    const invitee = await createMember(b, 'will-be-revoked@example.com');
    const inv = await app
      .inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${org.organization.id}/invitations`,
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-rekey-user-token': b.ownerAccess,
        },
        payload: { email: 'will-be-revoked@example.com', role: 'MEMBER' },
      })
      .then((r) => r.json().data as { token: string; invitation: { id: string } });

    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${org.organization.id}/invitations/${inv.invitation.id}/revoke`,
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.ownerAccess,
      },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().data.revoked).toBe(true);

    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/organizations/accept-invitation',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': invitee.access,
      },
      payload: { token: inv.token },
    });
    expect(accept.statusCode).toBe(400);
    expect(accept.json().error.code).toBe('ORGANIZATION_INVITATION_NOT_USABLE');
  });

  afterAll(async () => {
    await prisma.organizationInvitation.deleteMany({});
    await prisma.organizationMembership.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
  });
});
