/**
 * Sign-up takes `verifyUrl`, validated exactly as /auth/resend-verification
 * validates it, so a hosted portal can send the confirmation link to its own
 * verify-email page.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const PORTAL = new URL(process.env.PUBLIC_PORTAL_URL!).origin;
const SLUG = 'verify-url-app';
const PASSWORD = 'pw-one-two-three';

describe('sign-up verifyUrl', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let publicKey: string;

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
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'SUV', ownerEmail: 'suv@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    const created = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: SLUG, slug: SLUG },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    applicationId = created.id;
    publicKey = created.publicKey;
    await prisma.application.update({ where: { id: applicationId }, data: { hostedPortalEnabled: true } });
  });

  function signUp(email: string, verifyUrl: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${publicKey}` },
      payload: { email, password: PASSWORD, verifyUrl },
    });
  }

  it('mails the given portal URL with the token substituted', async () => {
    const dispatch = vi.spyOn(emailService, 'dispatch');
    const res = await signUp('portal@example.com', `${PORTAL}/${SLUG}/verify-email?token={token}`);
    expect(res.statusCode, res.body).toBe(201);
    await vi.waitFor(() =>
      expect(dispatch.mock.calls.some((c) => c[0].eventKey === 'email_verification')).toBe(true),
    );
    const sent = dispatch.mock.calls.find((c) => c[0].eventKey === 'email_verification')![0];
    const link = new URL(String(sent.variables.verifyUrl));
    expect(`${link.origin}${link.pathname}`).toBe(`${PORTAL}/${SLUG}/verify-email`);
    expect(link.searchParams.get('token')).toMatch(/.{16,}/);
  });

  it('refuses a foreign origin with the error resend gives, and creates nothing', async () => {
    const foreign = 'https://attacker.test/verify?token={token}';
    const res = await signUp('foreign@example.com', foreign);
    const resend = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/resend-verification',
      headers: { authorization: `Bearer ${publicKey}` },
      payload: { email: 'foreign@example.com', verifyUrl: foreign },
    });
    const { requestId: _a, ...refused } = res.json().error;
    const { requestId: _b, ...resendRefused } = resend.json().error;
    expect(res.statusCode).toBe(400);
    expect(refused).toEqual(resendRefused);
    expect(refused.code).toBe('AUTH_URL_NOT_ALLOWED');
    expect(await prisma.endUser.count({ where: { applicationId } })).toBe(0);
  });
});
