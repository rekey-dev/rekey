/**
 * `GET /api/v1/admin/applications/:id/plans/:slug/entitlements` is how the
 * Cloud billing service reads the `free` plan's rows, which it has to write
 * with no Free subscription in hand (a cancellation, a surplus workspace).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const admin = { authorization: `Bearer ${ADMIN_KEY}` };

describe('admin read of a plan entitlement bundle', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let tenantId: string;

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
        headers: admin,
        payload: { name: 'CloudT', ownerEmail: 'cloud@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    tenantId = tenant.id;
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: admin,
        payload: { tenantId: tenant.id, name: 'Account', slug: 'account' },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const plan = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${applicationId}/plans`,
        headers: admin,
        payload: { slug: 'free', name: 'Free', amount: 0 },
      })
      .then((r) => r.json().data as { id: string });
    await prisma.planEntitlement.createMany({
      data: [
        { planId: plan.id, kind: 'FEATURE', key: 'email_attribution', valueType: 'BOOL', value: 'true' },
        { planId: plan.id, kind: 'FEATURE', key: 'max_contacts', valueType: 'INT', value: '500' },
      ],
    });
  });

  const read = (slug: string, headers: Record<string, string> = admin) =>
    app.inject({ method: 'GET', url: `/api/v1/admin/applications/${applicationId}/plans/${slug}/entitlements`, headers });

  it('returns the rows the plan carries', async () => {
    const res = await read('free');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { kind: 'FEATURE', key: 'email_attribution', valueType: 'BOOL', value: 'true' },
      { kind: 'FEATURE', key: 'max_contacts', valueType: 'INT', value: '500' },
    ]);
  });

  it('answers PLAN_NOT_FOUND for a slug the application does not have', async () => {
    const res = await read('nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PLAN_NOT_FOUND');
  });

  it('answers 404 for an application id that does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/applications/app_does_not_exist/plans/free/entitlements',
      headers: admin,
    });
    expect(res.statusCode).toBe(404);
  });

  it('records the limits before and after when the super-admin sets them', async () => {
    const put = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: `/api/v1/admin/tenants/${tenantId}/limits`, headers: admin, payload });
    expect((await put({ maxProductionApps: 1 })).statusCode).toBe(200);
    expect((await put({ maxProductionApps: 3, maxContacts: 500 })).statusCode).toBe(200);
    const events = await waitForSecurityEvents({ type: 'workspace.limits_set_by_admin', tenantId }, { atLeast: 2 });
    const metadata = events.map((e) => e.metadata).reverse();
    expect(metadata).toContainEqual({ previous: { maxProductionApps: 1 }, limits: { maxProductionApps: 3, maxContacts: 500 } });
  });

  it('pages workspaces with identical createdAt without skipping or repeating one', async () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    await prisma.tenant.createMany({
      data: ['a', 'b', 'c', 'd', 'e'].map((k) => ({ name: `Tie ${k}`, ownerEmail: `tie-${k}@example.com`, createdAt: at })),
    });
    const seen: string[] = [];
    for (let offset = 0; offset < 5; offset += 1) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/metrics/tenants?q=tie-&sort=createdAt&order=asc&limit=1&offset=${offset}`,
        headers: admin,
      });
      seen.push(...(res.json().data.items as Array<{ id: string }>).map((t) => t.id));
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...seen].sort());
  });

  it('needs the super-admin key', async () => {
    const res = await read('free', {});
    expect(res.statusCode).toBe(401);
  });
});
