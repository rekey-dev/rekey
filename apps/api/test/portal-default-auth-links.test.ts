/**
 * An Application with no web page of its own (no appUrl, no redirect URLs) but
 * with the hosted portal on can require a verified email, and its emailed
 * links default to the portal's pages. The portal cannot then be turned off
 * while verification depends on it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const PORTAL = new URL(process.env.PUBLIC_PORTAL_URL!).origin;
const PASSWORD = 'pw-one-two-three';

describe('hosted portal as the default auth-link destination', () => {
  let app: FastifyInstance;
  let tenantAccess: string;
  let applicationId: string;
  let slug: string;
  let liveKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    slug = `desk-${Math.random().toString(36).slice(2, 8)}`;
    tenantAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: `App ${slug}`, slug },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  });

  const setAuthConfig = (patch: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: { authorization: `Bearer ${tenantAccess}` },
      payload: patch,
    });

  const setPortal = (enabled: boolean) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/portal`,
      headers: { authorization: `Bearer ${tenantAccess}` },
      payload: { enabled },
    });

  const call = (path: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/auth${path}`,
      headers: { authorization: `Bearer ${liveKey}` },
      payload,
    });

  async function mailedLink(
    dispatch: { mock: { calls: Array<Parameters<typeof emailService.dispatch>> } },
    eventKey: string,
    variable: string,
  ): Promise<URL> {
    await vi.waitFor(() => expect(dispatch.mock.calls.some((c) => c[0].eventKey === eventKey)).toBe(true));
    const sent = dispatch.mock.calls.find((c) => c[0].eventKey === eventKey)![0];
    return new URL(String(sent.variables[variable]));
  }

  it('without a portal, requiring a verified email is still refused', async () => {
    const refused = await setAuthConfig({ requireEmailVerification: true });
    expect(refused.statusCode).toBe(409);
    const error = refused.json().error as { code: string; fix: string };
    expect(error.code).toBe('EMAIL_VERIFICATION_URL_REQUIRED');
    expect(error.fix).toMatch(/Application URL/);
    expect(error.fix).toMatch(/hosted portal/);
  });

  it('with the portal on, accepts the setting and mails the portal verify-email page', async () => {
    expect((await setPortal(true)).statusCode).toBe(200);
    expect((await setAuthConfig({ requireEmailVerification: true })).statusCode).toBe(200);

    const dispatch = vi.spyOn(emailService, 'dispatch');
    const res = await call('/sign-up', { email: `u-${slug}@example.com`, password: PASSWORD });
    expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    const link = await mailedLink(dispatch, 'email_verification', 'verifyUrl');
    expect(`${link.origin}${link.pathname}`).toBe(`${PORTAL}/${slug}/verify-email`);

    const verified = await call('/verify-email', { token: link.searchParams.get('token') });
    expect(verified.statusCode, verified.body).toBe(200);
  });

  it('defaults the reset and sign-in links to the portal pages too', async () => {
    expect((await setPortal(true)).statusCode).toBe(200);
    expect((await setAuthConfig({ methods: ['password', 'magic_link'] })).statusCode).toBe(200);
    const email = `r-${slug}@example.com`;
    expect((await call('/sign-up', { email, password: PASSWORD })).statusCode).toBe(201);

    const dispatch = vi.spyOn(emailService, 'dispatch');
    await call('/forgot-password', { email });
    const reset = await mailedLink(dispatch, 'password_reset', 'resetUrl');
    expect(`${reset.origin}${reset.pathname}`).toBe(`${PORTAL}/${slug}/reset-password-link`);
    expect(reset.searchParams.get('token')).toBeTruthy();

    await call('/magic-link/request', { email });
    const signIn = await mailedLink(dispatch, 'magic_link_signin', 'signInUrl');
    expect(`${signIn.origin}${signIn.pathname}`).toBe(`${PORTAL}/${slug}/sign-in-link`);
    expect(signIn.searchParams.get('token')).toBeTruthy();
  });

  it('prefers the app URL over the portal when both exist', async () => {
    expect((await setPortal(true)).statusCode).toBe(200);
    expect((await setAuthConfig({ appUrl: 'https://desk.example.com' })).statusCode).toBe(200);
    const email = `a-${slug}@example.com`;
    expect((await call('/sign-up', { email, password: PASSWORD })).statusCode).toBe(201);
    const dispatch = vi.spyOn(emailService, 'dispatch');
    await call('/forgot-password', { email });
    const reset = await mailedLink(dispatch, 'password_reset', 'resetUrl');
    expect(`${reset.origin}${reset.pathname}`).toBe('https://desk.example.com/reset');
  });

  it('refuses to turn the portal off while verification depends on it', async () => {
    expect((await setPortal(true)).statusCode).toBe(200);
    expect((await setAuthConfig({ requireEmailVerification: true })).statusCode).toBe(200);

    const refused = await setPortal(false);
    expect(refused.statusCode).toBe(409);
    const error = refused.json().error as { code: string; fix: string };
    expect(error.code).toBe('EMAIL_VERIFICATION_URL_REQUIRED');
    expect(error.fix).toMatch(/then turn the portal off/);
    const row = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.hostedPortalEnabled).toBe(true);

    // Following the fix: set an app URL first, and the portal can go.
    expect((await setAuthConfig({ appUrl: 'https://desk.example.com' })).statusCode).toBe(200);
    expect((await setPortal(false)).statusCode).toBe(200);
  });

  it('turns the portal off freely when verification is not required', async () => {
    expect((await setPortal(true)).statusCode).toBe(200);
    expect((await setPortal(false)).statusCode).toBe(200);
  });
});
