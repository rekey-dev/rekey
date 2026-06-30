/**
 * Usage attributed to an org pool (owner+beneficiary). Records + aggregates
 * by `organizationId`, kept distinct from per-end-user + app-level usage.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('Usage — org pooling', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let liveKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `uo-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'UO', slug: `uo-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    // Meter + live key.
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/usage-meters`,
      headers: auth(),
      payload: { slug: 'api_calls', name: 'API calls', unit: 'calls' },
    });
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: auth(),
        payload: { name: 'k', mode: 'live', scopes: ['billing:write'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  });

  it('records + aggregates usage scoped to an org', async () => {
    const orgId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/organizations`,
        headers: auth(),
        payload: { name: 'Acme', slug: 'acme' },
      })
      .then((r) => (r.json().data as { id: string }).id);

    const key = { authorization: `Bearer ${liveKey}` };
    for (const q of [3, 5, 2]) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/usage/record',
        headers: key,
        payload: { meterSlug: 'api_calls', quantity: q, organizationId: orgId },
      });
      expect(r.statusCode).toBe(201);
    }

    const orgAgg = await app
      .inject({
        method: 'GET',
        url: `/api/v1/usage/aggregate?meterSlug=api_calls&organizationId=${orgId}`,
        headers: key,
      })
      .then((r) => r.json().data as { total: number; count: number });
    expect(orgAgg.total).toBe(10);
    expect(orgAgg.count).toBe(3);

    // A different org sees nothing; app-level (no subject) sums everything.
    const otherOrg = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/organizations`,
        headers: auth(),
        payload: { name: 'Other', slug: 'other' },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const otherAgg = await app
      .inject({ method: 'GET', url: `/api/v1/usage/aggregate?meterSlug=api_calls&organizationId=${otherOrg}`, headers: key })
      .then((r) => r.json().data as { total: number });
    expect(otherAgg.total).toBe(0);
  });

  it('rejects an ambiguous subject (both endUserId + organizationId)', async () => {
    const orgId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/organizations`,
        headers: auth(),
        payload: { name: 'Amb', slug: 'amb' },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/usage/record',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { meterSlug: 'api_calls', quantity: 1, organizationId: orgId, endUserId: 'eu_x' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('USAGE_SUBJECT_AMBIGUOUS');
  });
});
