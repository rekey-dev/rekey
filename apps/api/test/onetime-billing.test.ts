/**
 * One-time vs recurring checkout routing.
 *
 * CREDIT packs + perpetual (non-TIMED) LICENSE plans must go through the
 * provider's ONE-TIME flow (no recurring subscription); SUBSCRIPTION + TIMED
 * LICENSE plans recur. Under NODE_ENV=test the stub provider tags the two
 * paths with distinguishable URLs + the local row carries `metadata.oneTime`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const PASSWORD = 'pw-one-two-three';

describe('one-time vs recurring checkout', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;
  let tenantAccess: string;
  let euToken: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const slug = `onetime-${Math.random().toString(36).slice(2, 8)}`;
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
        payload: { name: `App ${slug}`, slug, enableBilling: true },
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
    euToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${slug}@example.com`, password: PASSWORD },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
  });

  const createPlan = (body: Record<string, unknown>) =>
    app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/plans`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: body,
      })
      .then((r) => {
        expect(r.statusCode).toBe(201);
        return r.json().data as Record<string, unknown>;
      });

  const checkout = (planSlug: string) =>
    app
      .inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': euToken },
        payload: {
          planSlug,
          successUrl: 'https://app.example/ok',
          cancelUrl: 'https://app.example/cancel',
        },
      })
      .then((r) => {
        expect(r.statusCode).toBe(200);
        return r.json().data as { url: string; subscription: { metadata: Record<string, unknown> } };
      });

  it('CREDIT pack → one-time checkout', async () => {
    await createPlan({ slug: 'pack', name: 'Pack', amount: 4999, kind: 'CREDIT', creditsAmount: 100 });
    const res = await checkout('pack');
    expect(res.url).toContain('/onetime/');
    expect(res.subscription.metadata.oneTime).toBe(true);
  });

  it('perpetual LICENSE → one-time checkout', async () => {
    await createPlan({ slug: 'perp', name: 'Perpetual', amount: 9999, kind: 'LICENSE', licenseKind: 'PERPETUAL' });
    const res = await checkout('perp');
    expect(res.url).toContain('/onetime/');
    expect(res.subscription.metadata.oneTime).toBe(true);
  });

  it('SUBSCRIPTION → recurring checkout (not one-time)', async () => {
    await createPlan({ slug: 'sub', name: 'Sub', amount: 999, kind: 'SUBSCRIPTION', interval: 'MONTH' });
    const res = await checkout('sub');
    expect(res.url).not.toContain('/onetime/');
    expect(res.subscription.metadata.oneTime).toBeUndefined();
  });

  it('TIMED LICENSE → recurring checkout (renews)', async () => {
    await createPlan({ slug: 'timed', name: 'Timed', amount: 1999, kind: 'LICENSE', licenseKind: 'TIMED', licenseDurationDays: 365 });
    const res = await checkout('timed');
    expect(res.url).not.toContain('/onetime/');
    expect(res.subscription.metadata.oneTime).toBeUndefined();
  });
});
