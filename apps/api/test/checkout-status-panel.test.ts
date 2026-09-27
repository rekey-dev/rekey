/**
 * The Billing page's status panel for the Rekey checkout page, and the cached
 * readiness read the page uses so a page view does not probe the portal.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { configureSandboxPaypal } from './fakes/billing-credentials.js';

describe('checkout status panel', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let operatorAccess: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    const slug = `csp-${Math.random().toString(36).slice(2, 8)}`;
    operatorAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
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
    await configureSandboxPaypal(applicationId);
  });

  function get(path: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}${path}`,
      headers: { authorization: `Bearer ${operatorAccess}` },
    });
  }

  it('reports settings, last webhook, fallbacks and completions', async () => {
    await prisma.application.update({ where: { id: applicationId }, data: { checkoutModeTest: 'EMBEDDED' } });
    await prisma.webhookEvent.create({
      data: { applicationId, provider: 'paypal', providerEventId: `WH-${randomUUID()}`, eventType: 'PAYMENT.SALE.COMPLETED', payload: {}, mode: 'test' },
    });
    await prisma.webhookEvent.create({
      data: { applicationId, provider: 'paypal', providerEventId: `WH-${randomUUID()}`, eventType: 'PAYMENT.SALE.COMPLETED', payload: {}, mode: 'live' },
    });
    for (const check of ['webhook', 'portal']) {
      await prisma.securityEvent.create({
        data: {
          applicationId,
          type: 'app.checkout_embedded_fallback',
          actorType: 'end_user',
          metadata: { check, provider: 'paypal', paymentMode: 'test' },
        },
      });
    }
    await prisma.securityEvent.create({
      data: {
        applicationId,
        type: 'app.checkout_embedded_fallback',
        actorType: 'end_user',
        metadata: { check: 'plans', provider: 'paypal', paymentMode: 'test' },
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      },
    });
    const res = await get('/checkout/status');
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as {
      settings: { checkoutModeTest: string };
      lastWebhooks: Array<{ provider: string; mode: string }>;
      fallbackCount: number;
      recentFallbacks: Array<{ check: string }>;
      lastEmbeddedCompleted: { test: string | null; live: string | null };
      readiness: unknown;
    };
    expect(data.settings.checkoutModeTest).toBe('EMBEDDED');
    // Labelled with the mode each event was verified in, not the credentials' mode today.
    expect(data.lastWebhooks.map((w) => `${w.provider}:${w.mode}`).sort()).toEqual(['paypal:live', 'paypal:test']);
    expect(data.fallbackCount).toBe(2);
    expect(data.recentFallbacks.map((f) => f.check).sort()).toEqual(['portal', 'webhook']);
    expect(data.lastEmbeddedCompleted).toEqual({ test: null, live: null });
    expect(data.readiness).toBeNull();
  });

  it('does not count another Application\'s fallbacks', async () => {
    await prisma.securityEvent.create({
      data: { applicationId: 'someone-else', type: 'app.checkout_embedded_fallback', actorType: 'end_user', metadata: { check: 'webhook' } },
    });
    expect((await get('/checkout/status')).json().data.fallbackCount).toBe(0);
  });

  it('serves the stored readiness with ?cached=true instead of probing the portal again', async () => {
    const probe = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 502 }));
    const first = await get('/checkout/readiness');
    expect(first.statusCode).toBe(200);
    const probesAfterRun = probe.mock.calls.length;
    await prisma.application.update({ where: { id: applicationId }, data: { checkoutReadinessAt: new Date(Date.now() - 60_000) } });
    const cached = await get('/checkout/readiness?cached=true');
    expect(cached.json().data.ranAt).toBe(first.json().data.ranAt);
    expect(probe.mock.calls.length).toBe(probesAfterRun);
    const status = (await get('/checkout/status')).json().data as { readiness: { test: Record<string, number> } };
    expect(status.readiness.test.FAIL).toBeGreaterThan(0);
  });
});
