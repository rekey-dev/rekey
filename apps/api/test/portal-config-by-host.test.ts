/**
 * The hosted portal on a custom domain: config is found by the VERIFIED domain
 * only, exactly, and every URL Rekey builds or accepts for that Application
 * uses the domain with no slug path.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { assertAllowedTokenUrl } from '../src/lib/app-url.js';
import { hostedPortalUrl } from '../src/lib/portal-origins.js';
import { checkReturnUrls } from '../src/modules/billing/checkout-return-url.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const PORTAL = new URL(process.env.PUBLIC_PORTAL_URL!).origin;
const DOMAIN = 'billing.acme.example';
const SLUG = 'acme-host';

describe('portal config by host', () => {
  let app: FastifyInstance;
  let applicationId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'Host', ownerEmail: 'host@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'Host App', slug: SLUG, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    await prisma.application.update({
      where: { id: applicationId },
      data: { hostedPortalEnabled: true, portalDomain: DOMAIN, portalDomainVerifiedAt: new Date() },
    });
  });

  const byHost = (host: string) =>
    app.inject({ method: 'GET', url: `/api/v1/portal/config?host=${encodeURIComponent(host)}` });

  async function expectHidden(host: string): Promise<void> {
    const res = await byHost(host);
    expect(res.statusCode, host).toBe(404);
    expect(res.json().error.code, host).toBe('PORTAL_NOT_FOUND');
  }

  it('returns the slug route payload, slug included, for a verified domain', async () => {
    const res = await byHost(DOMAIN);
    expect(res.statusCode).toBe(200);
    const bySlug = await app.inject({ method: 'GET', url: `/api/v1/portal/config/${SLUG}` });
    expect(res.json()).toEqual(bySlug.json());
    expect(res.json().data.slug).toBe(SLUG);
  });

  it('matches the host case-insensitively and with a trailing dot', async () => {
    expect((await byHost('Billing.ACME.example')).statusCode).toBe(200);
    expect((await byHost(`${DOMAIN}.`)).statusCode).toBe(200);
  });

  it('never matches an unverified domain', async () => {
    await prisma.application.update({ where: { id: applicationId }, data: { portalDomainVerifiedAt: null } });
    await expectHidden(DOMAIN);
  });

  it('hides a portal that is off or an application that is disabled', async () => {
    await prisma.application.update({ where: { id: applicationId }, data: { hostedPortalEnabled: false } });
    await expectHidden(DOMAIN);
    await prisma.application.update({
      where: { id: applicationId },
      data: { hostedPortalEnabled: true, disabledAt: new Date() },
    });
    await expectHidden(DOMAIN);
  });

  it('never matches by suffix, prefix, port or a malformed host', async () => {
    for (const host of ['acme.example', `x.${DOMAIN}`, `${DOMAIN}.evil.example`, `${DOMAIN}:443`, 'not a host', 'unknown.example']) {
      await expectHidden(host);
    }
  });

  it('requires the host', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/portal/config' })).statusCode).toBe(400);
  });

  describe('URLs for an application with a verified domain', () => {
    const verifiedApp = {
      slug: SLUG,
      hostedPortalEnabled: true,
      portalDomain: DOMAIN,
      portalDomainVerifiedAt: new Date(),
      authConfig: {},
    };
    const lapsedApp = { ...verifiedApp, portalDomainVerifiedAt: null };

    it('builds the portal link on the domain with no slug path', () => {
      expect(hostedPortalUrl(verifiedApp)).toBe(`https://${DOMAIN}`);
      expect(hostedPortalUrl(lapsedApp)).toBe(`${PORTAL}/${SLUG}`);
    });

    it('accepts emailed links at domain paths and at the shared slug paths, and not once lapsed', () => {
      for (const url of [
        `https://${DOMAIN}/sign-in/verify?token={token}`,
        `https://${DOMAIN}/verify-email?token={token}`,
        `https://${DOMAIN}/reset-password?token={token}`,
        `${PORTAL}/${SLUG}/reset-password?token={token}`,
      ]) {
        expect(() => assertAllowedTokenUrl(verifiedApp, url, 'resetUrl'), url).not.toThrow();
      }
      expect(() => assertAllowedTokenUrl(lapsedApp, `https://${DOMAIN}/reset-password?token={token}`, 'resetUrl')).toThrow(
        expect.objectContaining({ code: 'AUTH_URL_NOT_ALLOWED' }),
      );
    });

    it('accepts checkout returns on the domain without a warning, and warns once lapsed', () => {
      const urls = { successUrl: `https://${DOMAIN}/billing?checkout=success`, cancelUrl: `https://${DOMAIN}/billing` };
      expect(checkReturnUrls(verifiedApp, urls)).toEqual([]);
      expect(checkReturnUrls(lapsedApp, urls).map((w) => w.code)).toEqual([
        'CHECKOUT_RETURN_URL_UNREGISTERED',
        'CHECKOUT_RETURN_URL_UNREGISTERED',
      ]);
    });
  });
});
