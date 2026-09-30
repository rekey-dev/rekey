/**
 * The hosted portal's own pages are an allowed destination for emailed token
 * links, but only this Application's own pages.
 *
 * The portal builds `resetUrl` as `<portal>/<slug>/reset-password?token={token}`.
 * Enabling the portal never registered that origin, so every portal reset was
 * refused with AUTH_URL_NOT_ALLOWED and the customer saw a generic failure.
 * The shared portal host serves every Application, so the allowance is scoped
 * to this app's slug; anything else there is someone else's page.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const PORTAL = new URL(process.env.PUBLIC_PORTAL_URL ?? 'https://portal.test.invalid').origin;
const SLUG = 'acme';
const EMAIL = 'buyer@example.com';

describe('portal token URLs', () => {
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

  async function createApp(tenantId: string, slug: string): Promise<{ id: string; publicKey: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { tenantId, name: slug, slug, enableBilling: true },
    });
    return res.json().data as { id: string; publicKey: string };
  }

  beforeEach(async () => {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'PTU', ownerEmail: 'ptu@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    const created = await createApp(tenant.id, SLUG);
    applicationId = created.id;
    publicKey = created.publicKey;
    // A neighbour whose slug starts with ours, for the prefix probes.
    await createApp(tenant.id, `${SLUG}-other`);
    await prisma.application.update({
      where: { id: applicationId },
      data: { hostedPortalEnabled: true },
    });
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${publicKey}` },
      payload: { email: EMAIL, password: 'pw-one-two-three' },
    });
    expect(signUp.statusCode).toBe(201);
  });

  function forgot(resetUrl: string, email = EMAIL) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: { authorization: `Bearer ${publicKey}` },
      payload: { email, resetUrl },
    });
  }

  function resendVerification(verifyUrl: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/resend-verification',
      headers: { authorization: `Bearer ${publicKey}` },
      payload: { email: EMAIL, verifyUrl },
    });
  }

  function refusal(res: { statusCode: number; json: () => unknown }): string | undefined {
    if (res.statusCode !== 400) return undefined;
    return (res.json() as { error?: { code?: string } }).error?.code;
  }

  it('accepts a reset link into this app\'s own portal pages', async () => {
    const res = await forgot(`${PORTAL}/${SLUG}/reset-password?token={token}`);
    expect(res.statusCode).toBe(200);
  });

  it('accepts a verification link into this app\'s own portal pages', async () => {
    const res = await resendVerification(`${PORTAL}/${SLUG}/verify?token={token}`);
    expect(res.statusCode).toBe(200);
  });

  it('refuses another app\'s pages on the same shared portal host', async () => {
    for (const path of [`/${SLUG}-other/reset-password`, `/${SLUG}-other`, '/someone-else/reset-password', '/']) {
      const res = await forgot(`${PORTAL}${path}?token={token}`);
      expect(refusal(res), path).toBe('AUTH_URL_NOT_ALLOWED');
    }
  });

  it('refuses paths that climb out of this app\'s slug, plain or encoded', async () => {
    const escapes = [
      `/${SLUG}/../${SLUG}-other/reset-password`,
      `/${SLUG}/%2e%2e/${SLUG}-other/reset-password`,
      `/${SLUG}/%2E%2E/${SLUG}-other/reset-password`,
      `/${SLUG}/.%2e/${SLUG}-other/reset-password`,
      `/${SLUG}%2f..%2f${SLUG}-other/reset-password`,
      `/${SLUG}%2F${SLUG}-other`,
      `/${SLUG}/x%2f..%2f..%2f${SLUG}-other`,
      `/${SLUG}/x%5c..%5c..%5c${SLUG}-other`,
      `/${SLUG}%5c..%5c${SLUG}-other`,
      `/${SLUG}\\..\\${SLUG}-other`,
      `/${SLUG}//evil`,
      `/${SLUG}/./reset-password`,
      `/${SLUG}/\t../${SLUG}-other`,
    ];
    for (const path of escapes) {
      const res = await forgot(`${PORTAL}${path}?token={token}`);
      expect(refusal(res), path).toBe('AUTH_URL_NOT_ALLOWED');
    }
  });

  it('refuses the portal once the portal is turned off', async () => {
    await prisma.application.update({
      where: { id: applicationId },
      data: { hostedPortalEnabled: false },
    });
    const res = await forgot(`${PORTAL}/${SLUG}/reset-password?token={token}`);
    expect(refusal(res)).toBe('AUTH_URL_NOT_ALLOWED');
  });

  it('allows a verified custom portal domain and refuses an unverified one', async () => {
    await prisma.application.update({
      where: { id: applicationId },
      data: { portalDomain: 'billing.acme.test', portalDomainVerifiedAt: null },
    });
    const unverified = await forgot('https://billing.acme.test/reset-password?token={token}');
    expect(refusal(unverified)).toBe('AUTH_URL_NOT_ALLOWED');

    await prisma.application.update({
      where: { id: applicationId },
      data: { portalDomainVerifiedAt: new Date() },
    });
    const verified = await forgot('https://billing.acme.test/reset-password?token={token}');
    expect(verified.statusCode).toBe(200);
    // Origin-scoped: plain http on the same host is a different origin.
    const insecure = await forgot('http://billing.acme.test/reset-password?token={token}');
    expect(refusal(insecure)).toBe('AUTH_URL_NOT_ALLOWED');
  });

  it('refuses credentials in a portal URL, on the shared host and a verified custom domain', async () => {
    await prisma.application.update({
      where: { id: applicationId },
      data: { portalDomain: 'billing.acme.test', portalDomainVerifiedAt: new Date() },
    });
    const portalHost = new URL(PORTAL).host;
    for (const url of [
      `https://attacker.tld@${portalHost}/${SLUG}/reset-password?token={token}`,
      `https://user:pass@${portalHost}/${SLUG}/reset-password?token={token}`,
      'https://attacker.tld@billing.acme.test/reset-password?token={token}',
    ]) {
      const res = await forgot(url);
      expect(refusal(res), url).toBe('AUTH_URL_NOT_ALLOWED');
      expect(res.json().error.message, url).toContain('must not contain credentials');
    }
  });

  it('refuses a verified custom domain once the portal is off', async () => {
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        hostedPortalEnabled: false,
        portalDomain: 'billing.acme.test',
        portalDomainVerifiedAt: new Date(),
      },
    });
    const res = await forgot('https://billing.acme.test/reset-password?token={token}');
    expect(refusal(res)).toBe('AUTH_URL_NOT_ALLOWED');
  });

  it('does not write the portal into the operator\'s redirect URLs', async () => {
    await forgot(`${PORTAL}/${SLUG}/reset-password?token={token}`);
    const row = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const config = (row.authConfig ?? {}) as { redirectUrls?: unknown };
    expect(config.redirectUrls ?? []).toEqual([]);
  });

  // The refusal must not depend on whether the address has an account: a
  // publishable key is public, so a known-only 400 would be an account oracle.
  it('refuses an unknown address exactly like a known one', async () => {
    const bad = 'https://attacker.test/reset?token={token}';
    const known = await forgot(bad, EMAIL);
    const unknown = await forgot(bad, 'nobody@example.com');
    expect(refusal(known)).toBe('AUTH_URL_NOT_ALLOWED');
    expect(refusal(unknown)).toBe('AUTH_URL_NOT_ALLOWED');
  });

  it('refuses a verification re-send to an unknown address exactly like a known one', async () => {
    const bad = 'https://attacker.test/verify?token={token}';
    const request = (email: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/resend-verification',
        headers: { authorization: `Bearer ${publicKey}` },
        payload: { email, verifyUrl: bad },
      });
    expect(refusal(await request(EMAIL))).toBe('AUTH_URL_NOT_ALLOWED');
    expect(refusal(await request('nobody@example.com'))).toBe('AUTH_URL_NOT_ALLOWED');
  });

  it('refuses a magic link to an unknown address exactly like a known one', async () => {
    const row = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        authConfig: {
          ...(row.authConfig as Record<string, unknown>),
          methods: ['password', 'magic_link'],
          signupMode: 'invite_only',
        },
      },
    });
    const bad = 'https://attacker.test/in?token={token}';
    const request = (email: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/request',
        headers: { authorization: `Bearer ${publicKey}` },
        payload: { email, signInUrl: bad },
      });
    expect(refusal(await request(EMAIL))).toBe('AUTH_URL_NOT_ALLOWED');
    expect(refusal(await request('nobody@example.com'))).toBe('AUTH_URL_NOT_ALLOWED');
  });
});
