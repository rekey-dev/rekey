/**
 * An invitation is emailed to the invited address, in the Application's
 * branding, with a link that resolves like the other emailed auth links:
 * the caller's `inviteUrl` when it is on a registered origin, else the app's
 * own page, else the hosted portal (shared host or verified custom domain).
 * The mail obeys the Application's email switches and the recipient cap, and
 * the response still carries the token.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';
import { renderForEvent } from '../src/modules/email/email.service.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { as, invite, orgApp, type OrgApp } from './organization-fixtures.js';

operatorsConfirmTheirEmail();

const PORTAL = new URL(process.env.PUBLIC_PORTAL_URL!).origin;

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
});

function capture() {
  return vi.spyOn(emailService, 'dispatch').mockResolvedValue({ kind: 'sent', messageId: 'm_1', via: 'pool' } as never);
}

function sentInvitations(spy: ReturnType<typeof capture>) {
  return spy.mock.calls.map((c) => c[0]).filter((d) => d.eventKey === 'organization_invitation');
}

async function setPortal(o: OrgApp, enabled: boolean): Promise<void> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/v1/tenant/applications/${o.applicationId}/portal`,
    headers: { authorization: `Bearer ${o.operatorToken}` },
    payload: { enabled },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function setAppUrl(o: OrgApp, appUrl: string): Promise<void> {
  const app0 = await prisma.application.findUniqueOrThrow({ where: { id: o.applicationId } });
  await prisma.application.update({
    where: { id: o.applicationId },
    data: { authConfig: { ...(app0.authConfig as object), appUrl } as never },
  });
}

const slugOf = async (o: OrgApp) =>
  (await prisma.application.findUniqueOrThrow({ where: { id: o.applicationId }, select: { slug: true } })).slug;

describe('emailing an organization invitation', () => {
  it("mails the invited address a link to the shared portal's invitation page, and still returns the token", async () => {
    const o = await orgApp(app, 'mail-shared');
    await setPortal(o, true);
    const spy = capture();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${o.organizationId}/invitations`,
      headers: as(o, o.owner),
      payload: { email: 'Guest@Example.com', role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { token: string; emailSent: boolean; warning: string };
    expect(data.emailSent).toBe(true);
    expect(data.warning).toBe(
      'Rekey emailed the invitation link to guest@example.com. The raw token is shown only in this response.',
    );

    const [sent] = sentInvitations(spy);
    expect(sent!.to).toBe('guest@example.com');
    expect(sent!.variables).toMatchObject({
      inviteeEmail: 'guest@example.com',
      inviterEmail: o.owner.email,
      organizationName: 'Org mail-shared',
      roleName: 'Admin',
      inviteUrl: `${PORTAL}/${await slugOf(o)}/invitation-link?token=${encodeURIComponent(data.token)}`,
    });
  });

  it("links a verified custom portal domain with no slug segment", async () => {
    const o = await orgApp(app, 'mail-domain');
    await setPortal(o, true);
    await prisma.application.update({
      where: { id: o.applicationId },
      data: { portalDomain: 'billing.example.test', portalDomainVerifiedAt: new Date() },
    });
    const spy = capture();
    const { token } = await invite(app, o, o.owner, 'domain@example.com');
    expect(sentInvitations(spy)[0]!.variables.inviteUrl).toBe(
      `https://billing.example.test/invitation-link?token=${encodeURIComponent(token)}`,
    );
  });

  it("prefers the app's own accept-invitation page when it has an App URL", async () => {
    const o = await orgApp(app, 'mail-appurl');
    await setPortal(o, true);
    await setAppUrl(o, 'https://app.example.test');
    const spy = capture();
    const { token } = await invite(app, o, o.owner, 'appurl@example.com');
    expect(sentInvitations(spy)[0]!.variables.inviteUrl).toBe(
      `https://app.example.test/accept-invitation?token=${encodeURIComponent(token)}`,
    );
  });

  it('uses an inviteUrl on a registered origin, and refuses one elsewhere before inviting anyone', async () => {
    const o = await orgApp(app, 'mail-explicit');
    await setAppUrl(o, 'https://app.example.test');
    const spy = capture();
    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${o.organizationId}/invitations`,
      headers: as(o, o.owner),
      payload: { email: 'explicit@example.com', inviteUrl: 'https://app.example.test/team/join?t={token}' },
    });
    const token = ok.json().data.token as string;
    expect(sentInvitations(spy)[0]!.variables.inviteUrl).toBe(
      `https://app.example.test/team/join?t=${encodeURIComponent(token)}`,
    );

    const refused = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${o.organizationId}/invitations`,
      headers: as(o, o.owner),
      payload: { email: 'phished@example.com', inviteUrl: 'https://evil.example.net/join?t={token}' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('AUTH_URL_NOT_ALLOWED');
    expect(await prisma.organizationInvitation.count({ where: { email: 'phished@example.com' } })).toBe(0);
    expect(sentInvitations(spy)).toHaveLength(1);
  });

  it('sends nothing and says so when no link page exists', async () => {
    const o = await orgApp(app, 'mail-nowhere');
    const spy = capture();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${o.organizationId}/invitations`,
      headers: as(o, o.owner),
      payload: { email: 'nowhere@example.com' },
    });
    expect(res.json().data).toMatchObject({
      emailSent: false,
      warning: 'No invitation email was sent. Share the raw token through your own channel; it is shown only in this response.',
    });
    expect(sentInvitations(spy)).toHaveLength(0);
  });

  it("obeys the Application's email switch", async () => {
    const o = await orgApp(app, 'mail-off');
    await setPortal(o, true);
    await prisma.application.update({ where: { id: o.applicationId }, data: { emailsEnabled: false } });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${o.organizationId}/invitations`,
      headers: as(o, o.owner),
      payload: { email: 'off@example.com' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.emailSent).toBe(false);
  });

  it("stops mailing an address at the recipient's auth-email cap, while the invitations still stand", async () => {
    process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = '1';
    const o = await orgApp(app, 'mail-cap');
    await setPortal(o, true);
    const spy = capture();
    for (let i = 0; i < 6; i += 1) await invite(app, o, o.owner, 'capped@example.com');
    expect(sentInvitations(spy)).toHaveLength(5);
    expect(await prisma.organizationInvitation.count({ where: { email: 'capped@example.com' } })).toBe(6);
  });

  it('mails a resent invitation with its fresh link', async () => {
    const o = await orgApp(app, 'mail-resend');
    await setPortal(o, true);
    const first = await invite(app, o, o.owner, 'again@example.com');
    const spy = capture();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${o.organizationId}/invitations/${first.invitation.id}/resend`,
      headers: as(o, o.owner),
    });
    const fresh = res.json().data as { token: string; emailSent: boolean };
    expect(fresh.emailSent).toBe(true);
    expect(sentInvitations(spy)[0]!.variables.inviteUrl).toBe(
      `${PORTAL}/${await slugOf(o)}/invitation-link?token=${encodeURIComponent(fresh.token)}`,
    );
  });

  it("renders the default in the Application's branding, written for the invited person", async () => {
    const o = await orgApp(app, 'mail-brand');
    await prisma.application.update({
      where: { id: o.applicationId },
      data: { portalBranding: { displayName: 'Acme Cloud' } },
    });
    const rendered = await renderForEvent(o.applicationId, 'organization_invitation', {
      inviteeEmail: 'guest@example.com',
      inviterEmail: 'boss@example.com',
      organizationName: 'Platform team',
      roleName: 'Member',
      inviteUrl: 'https://portal.test.invalid/acme/invitation-link?token=t',
      expiresAtIso: '2026-12-01T00:00:00.000Z',
    });
    expect(rendered.subject).toBe('boss@example.com invited you to Platform team on Acme Cloud');
    expect(rendered.text).toContain('https://portal.test.invalid/acme/invitation-link?token=t');
    expect(rendered.text).toContain('expires at 1 Dec 2026');
    expect(rendered.text).toContain('safely ignore this email');
  });
});
