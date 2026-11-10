/**
 * Reading an invitation by its token, with no session, for the page the link
 * opens. It names the organization and the role and masks every address, and
 * every token that cannot be accepted gets one identical answer.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { invitationPreviewRateLimitKey } from '../src/lib/rate-limit.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { as, endUser, invite, orgApp } from './organization-fixtures.js';

operatorsConfirmTheirEmail();

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const URL = '/api/v1/auth/organizations/invitation-preview';

function preview(key: string, token: string) {
  return app.inject({ method: 'POST', url: URL, headers: { authorization: `Bearer ${key}` }, payload: { token } });
}

describe('previewing an invitation by its token', () => {
  it('needs no session and returns only the names, the role, masked addresses and the expiry', async () => {
    const o = await orgApp(app, 'preview-ok');
    const inv = await invite(app, o, o.owner, 'jane.doe@example.com', 'ADMIN');

    const res = await preview(o.key, inv.token);
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      ['applicationName', 'expiresAt', 'invitedBy', 'invitedEmail', 'organizationName', 'role'].sort(),
    );
    expect(data).toMatchObject({
      organizationName: 'Org preview-ok',
      applicationName: 'App preview-ok',
      role: 'ADMIN',
      invitedEmail: 'j***@example.com',
      invitedBy: 'o***@example.com',
    });
    expect(res.body).not.toContain('jane.doe');
    expect(res.body).not.toContain(o.owner.email);
    expect(res.body).not.toContain(o.organizationId);
    expect(res.body).not.toContain(inv.invitation.id);
    expect(res.body).not.toContain(inv.token);
  });

  it('answers unknown, expired, revoked, used and other-Application tokens identically', async () => {
    const o = await orgApp(app, 'preview-dead');
    const other = await orgApp(app, 'preview-other');
    const expired = await invite(app, o, o.owner, 'expired@example.com');
    await prisma.organizationInvitation.update({
      where: { id: expired.invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const revoked = await invite(app, o, o.owner, 'revoked@example.com');
    await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${o.organizationId}/invitations/${revoked.invitation.id}/revoke`,
      headers: as(o, o.owner),
    });
    const usedBy = await endUser(app, o, 'used@example.com');
    const used = await invite(app, o, o.owner, 'used@example.com');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/organizations/accept-invitation',
      headers: as(o, usedBy),
      payload: { token: used.token },
    });
    const foreign = await invite(app, other, other.owner, 'foreign@example.com');

    const answers = await Promise.all(
      ['never-issued-token', expired.token, revoked.token, used.token, foreign.token].map((t) => preview(o.key, t)),
    );
    for (const res of answers) {
      expect(res.statusCode).toBe(404);
      const { code, message, fix } = res.json().error as Record<string, unknown>;
      expect({ code, message, fix }).toEqual({
        code: 'ORGANIZATION_INVITATION_UNAVAILABLE',
        message: 'This invitation is no longer valid.',
        fix: 'Ask the person who invited you to send a new invitation.',
      });
    }
  });

  it('keys its rate limit on the Application and the client address', () => {
    expect(invitationPreviewRateLimitKey({ application: { id: 'app_1' }, ip: '203.0.113.9' } as never)).toBe(
      'invitepreview:app_1:203.0.113.9',
    );
  });
});
