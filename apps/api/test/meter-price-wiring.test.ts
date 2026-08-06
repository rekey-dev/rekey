import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('meter price is reachable through the API', () => {
  let app: FastifyInstance; let token: string; let appId: string;
  beforeAll(async () => { app = await buildApp({ logger: false }); await app.ready(); });
  afterAll(async () => { await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } }); await app.close(); });
  const auth = () => ({ authorization: `Bearer ${token}` });

  it('accepts creditsPerUnit on create and on a price-only PATCH', async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app.inject({ method: 'POST', url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `mw-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` } })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app.inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: auth(),
      payload: { name: 'MW', slug: `mw-${slug}`, enableBilling: true } })
      .then((r) => (r.json().data as { id: string }).id);

    // create must persist the price, not silently drop it
    const created = await app.inject({ method: 'POST', url: `/api/v1/tenant/applications/${appId}/usage-meters`,
      headers: auth(), payload: { slug: 'calls', name: 'calls', unit: 'calls', creditsPerUnit: 2 } });
    expect(created.statusCode).toBe(201);
    expect((created.json().data as { creditsPerUnit: number }).creditsPerUnit).toBe(2);

    // a price-only PATCH must not be rejected for lacking `active`
    const patched = await app.inject({ method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/usage-meters/calls`, headers: auth(),
      payload: { creditsPerUnit: 7 } });
    expect(patched.statusCode).toBe(200);
    expect((await prisma.usageMeter.findFirstOrThrow({ where: { applicationId: appId, slug: 'calls' } })).creditsPerUnit).toBe(7);

    // null clears it
    await app.inject({ method: 'PATCH', url: `/api/v1/tenant/applications/${appId}/usage-meters/calls`,
      headers: auth(), payload: { creditsPerUnit: null } });
    expect((await prisma.usageMeter.findFirstOrThrow({ where: { applicationId: appId, slug: 'calls' } })).creditsPerUnit).toBeNull();
  });
});
