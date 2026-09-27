/**
 * Checkout return URLs, in warn mode.
 *
 * A return URL on an origin the Application never registered is still allowed
 * but reported: a `CHECKOUT_RETURN_URL_UNREGISTERED` warning in the response
 * and a security event the panel reads. A non-http(s) URL is refused outright,
 * before anything is created.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';

const PASSWORD = 'pw-one-two-three';
const REGISTERED = 'https://app.example';
const PORTAL = new URL(process.env.PUBLIC_PORTAL_URL!).origin;

interface CheckoutWarningBody {
  code: string;
  field: string;
  origin: string;
  message: string;
  fix: string;
}

describe('checkout return URLs', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;
  let userAccess: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const slug = `returl-${Math.random().toString(36).slice(2, 8)}`;
    const operatorAccess = await app
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
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await configureSandboxStripe(applicationId);
    const plan = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${operatorAccess}` },
      payload: { slug: 'pro', name: 'Pro', amount: 1000 },
    });
    expect(plan.statusCode).toBe(201);
    userAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${slug}@example.com`, password: PASSWORD },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
  });

  async function registerOrigins(authConfig: { appUrl?: string; redirectUrls?: string[] }): Promise<void> {
    const current = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const merged: Prisma.InputJsonObject = { ...(current.authConfig as Prisma.JsonObject), ...authConfig };
    await prisma.application.update({ where: { id: applicationId }, data: { authConfig: merged } });
  }

  function checkout(successUrl: string, cancelUrl: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
      payload: { planSlug: 'pro', successUrl, cancelUrl, provider: 'stripe' },
    });
  }

  async function returnUrlEvents(): Promise<Array<{ metadata: unknown }>> {
    // Recorded fire-and-forget after the response, so give it a moment.
    for (let i = 0; i < 20; i++) {
      const rows = await prisma.securityEvent.findMany({
        where: { applicationId, type: 'app.checkout_return_url_unregistered' },
      });
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  }

  it('warns, and still returns a checkout, for an unregistered origin', async () => {
    await registerOrigins({ appUrl: `${REGISTERED}/home` });
    const res = await checkout('https://elsewhere.example/thanks', `${REGISTERED}/cancel`);
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { url: string; warnings: CheckoutWarningBody[] };
    expect(data.url).toBeTruthy();
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toMatchObject({
      code: 'CHECKOUT_RETURN_URL_UNREGISTERED',
      field: 'successUrl',
      origin: 'https://elsewhere.example',
    });
    expect(data.warnings[0]!.fix).toContain('https://elsewhere.example');

    const events = await returnUrlEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({
      origins: ['https://elsewhere.example'],
      fields: ['successUrl'],
    });
  });

  it('says so when the Application has registered no origin at all', async () => {
    const res = await checkout(`${REGISTERED}/ok`, `${REGISTERED}/cancel`);
    expect(res.statusCode).toBe(200);
    const warnings = (res.json().data as { warnings: CheckoutWarningBody[] }).warnings;
    expect(warnings.map((w) => w.field)).toEqual(['successUrl', 'cancelUrl']);
    expect(warnings[0]!.message).toContain('no registered origin');
    expect(warnings[0]!.fix).toContain('Application URL');
  });

  it('does not warn for a registered origin, by appUrl or by redirect URL', async () => {
    await registerOrigins({ appUrl: REGISTERED, redirectUrls: ['https://other.example/callback'] });
    const res = await checkout(`${REGISTERED}/billing?ok=1`, 'https://other.example/pricing');
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { warnings: unknown[] }).warnings).toEqual([]);
    expect(await returnUrlEvents()).toHaveLength(0);
  });

  it('does not warn for the hosted portal of an Application that uses it', async () => {
    await registerOrigins({ appUrl: REGISTERED });
    await prisma.application.update({ where: { id: applicationId }, data: { hostedPortalEnabled: true } });
    const res = await checkout(`${PORTAL}/some-app?checkout=success`, `${PORTAL}/some-app?checkout=canceled`);
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { warnings: unknown[] }).warnings).toEqual([]);
  });

  it('warns for the portal origin when the Application has not enabled the portal', async () => {
    await registerOrigins({ appUrl: REGISTERED });
    const res = await checkout(`${PORTAL}/some-app?checkout=success`, `${REGISTERED}/cancel`);
    expect(res.statusCode).toBe(200);
    const warnings = (res.json().data as { warnings: CheckoutWarningBody[] }).warnings;
    expect(warnings.map((w) => w.origin)).toEqual([PORTAL]);
  });

  it.each([
    ['javascript:alert(document.domain)', 'successUrl'],
    ['JaVaScRiPt:alert(1)', 'successUrl'],
    ['data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'successUrl'],
    ['ftp://files.example/x', 'successUrl'],
  ])('refuses %s with CHECKOUT_RETURN_URL_INVALID and creates nothing', async (bad) => {
    await registerOrigins({ appUrl: REGISTERED });
    const res = await checkout(bad, `${REGISTERED}/cancel`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'CHECKOUT_RETURN_URL_INVALID' });
    expect(await prisma.subscription.count({ where: { applicationId } })).toBe(0);
  });

  it('refuses a non-http(s) cancelUrl too', async () => {
    await registerOrigins({ appUrl: REGISTERED });
    const res = await checkout(`${REGISTERED}/ok`, 'javascript:history.back()');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'CHECKOUT_RETURN_URL_INVALID' });
  });
});
