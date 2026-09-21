/**
 * Per-app Overview stats endpoint, GET /tenant/applications/:id/stats.
 *
 * Asserts the aggregation shape: end-user totals + a 30-day gap-filled sign-up
 * trend, the billing snapshot (off by default for new apps), and that the
 * counts are scoped to the calling Application.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';
import { prisma } from '../src/lib/prisma.js';
import { countQueries } from './query-counter.js';

interface Stats {
  users: { total: number; verified: number; newLast7d: number; newLast30d: number; signupTrend: Array<{ date: string; count: number }> };
  security: { eventsLast30d: number; signInsLast30d: number; signUpsLast30d: number };
  billing: { enabled: boolean; activeSubscriptions: number; plansActive: number; plansTotal: number };
  usage: { creditsOutstanding: number; usageLast30d: number };
}

describe('per-app overview stats', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('aggregates end-user totals, a 30-day signup trend, and a billing snapshot', async () => {
    const slug = 'stats-app';
    const tenantAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    const applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: `App ${slug}`, slug }, // billing intentionally left OFF
      })
      .then((r) => (r.json().data as { id: string }).id);

    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    // Two end-user sign-ups.
    for (const n of [1, 2]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${n}-${slug}@example.com`, password: 'pw-one-two-three' },
      });
      expect(res.statusCode).toBe(201);
    }

    // The security summary below counts `user.signed_up` events, which are
    // written fire-and-forget. Wait for both to land BEFORE reading stats -
    // the old comment claimed they "flush on the round-trip", which is a race,
    // not a guarantee, and it lost on a loaded CI runner.
    await waitForSecurityEvents({ type: 'user.signed_up', applicationId }, { atLeast: 2 });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/stats`,
      headers: { authorization: `Bearer ${tenantAccess}` },
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json().data as Stats;

    // End-user totals (direct counts, deterministic).
    expect(stats.users.total).toBe(2);
    expect(stats.users.newLast7d).toBe(2);
    expect(stats.users.signupTrend).toHaveLength(30);
    // Last bucket is today and should hold both of today's sign-ups.
    expect(stats.users.signupTrend[29]!.count).toBe(2);

    // Billing snapshot, new apps default OFF.
    expect(stats.billing.enabled).toBe(false);
    expect(stats.billing.activeSubscriptions).toBe(0);
    expect(stats.billing.plansTotal).toBe(0);

    // Usage roll-up present + zeroed for a fresh app.
    expect(stats.usage.creditsOutstanding).toBe(0);
    expect(stats.usage.usageLast30d).toBe(0);

    // Security summary captured the two sign-ups (awaited above).
    expect(stats.security.signUpsLast30d).toBeGreaterThanOrEqual(2);
  });

  it('counts every tile from seeded rows, in one statement', async () => {
    const tenantAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: 'op-stats-seed@example.com', password: 'pw-one-two-three', workspaceName: 'WS seed' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: 'App seed', slug: 'stats-seed' },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const read = async (): Promise<Stats> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${applicationId}/stats`,
        headers: { authorization: `Bearer ${tenantAccess}` },
      });
      expect(res.statusCode).toBe(200);
      return res.json().data as Stats;
    };
    // Whatever creating the app itself recorded (security events) is the base.
    const base = await read();

    const day = 24 * 60 * 60 * 1000;
    const ago = (days: number) => new Date(Date.now() - days * day);
    const mkUser = (email: string, emailVerified: boolean, createdAt: Date) =>
      prisma.endUser.create({ data: { applicationId, email, emailVerified, createdAt } });
    const e1 = await mkUser('s1@example.com', true, new Date());
    const e2 = await mkUser('s2@example.com', false, new Date());
    await mkUser('s3@example.com', true, ago(10));
    await mkUser('s4@example.com', false, ago(40));

    const event = (type: string, createdAt: Date) =>
      prisma.securityEvent.create({ data: { applicationId, type, actorType: 'end_user', createdAt } });
    await event('user.signed_in', new Date());
    await event('user.signed_in', new Date());
    await event('user.signed_up', new Date());
    await event('user.password_changed', new Date());
    await event('user.signed_in', ago(40));

    const plan = await prisma.plan.create({
      data: { applicationId, slug: 'pro', name: 'Pro', amount: 1000 },
    });
    await prisma.plan.create({
      data: { applicationId, slug: 'old', name: 'Old', amount: 500, active: false },
    });
    await prisma.subscription.create({
      data: { applicationId, endUserId: e1.id, planId: plan.id, status: 'ACTIVE' },
    });
    await prisma.subscription.create({
      data: { applicationId, endUserId: e2.id, planId: plan.id, status: 'CANCELED' },
    });
    await prisma.creditBalance.create({ data: { applicationId, subjectKey: `user:${e1.id}`, balance: 50 } });
    await prisma.creditBalance.create({ data: { applicationId, subjectKey: `user:${e2.id}`, balance: 25 } });
    const meter = await prisma.usageMeter.create({
      data: { applicationId, slug: 'calls', name: 'Calls', unit: 'call' },
    });
    await prisma.usageRecord.create({ data: { meterId: meter.id, quantity: 3, endUserId: e1.id } });
    await prisma.usageRecord.create({ data: { meterId: meter.id, quantity: 4, endUserId: e1.id } });
    await prisma.usageRecord.create({
      data: { meterId: meter.id, quantity: 100, endUserId: e1.id, occurredAt: ago(40) },
    });

    const s = await read();
    expect(s.users.total).toBe(base.users.total + 4);
    expect(s.users.verified).toBe(base.users.verified + 2);
    expect(s.users.newLast7d).toBe(base.users.newLast7d + 2);
    expect(s.users.newLast30d).toBe(base.users.newLast30d + 3);
    expect(s.users.signupTrend.at(-1)!.count).toBe(base.users.signupTrend.at(-1)!.count + 2);
    expect(s.users.signupTrend.at(-11)!.count).toBe(base.users.signupTrend.at(-11)!.count + 1);
    expect(s.security.eventsLast30d).toBe(base.security.eventsLast30d + 4);
    expect(s.security.signInsLast30d).toBe(base.security.signInsLast30d + 2);
    expect(s.security.signUpsLast30d).toBe(base.security.signUpsLast30d + 1);
    expect(s.billing).toEqual({ enabled: false, activeSubscriptions: 1, plansActive: 1, plansTotal: 2 });
    expect(s.usage).toEqual({ creditsOutstanding: 75, usageLast30d: 7 });

    // One statement, and the application is not re-read after the access check.
    const c = await countQueries(read);
    expect(c.queries.filter((q) => /end_users|security_events|plans|subscriptions/.test(q))).toHaveLength(1);
  });

  it('refuses an application from another workspace', async () => {
    // Workspace A owns an app.
    const tsA = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: 'op-stats-a@example.com', password: 'pw-one-two-three', workspaceName: 'WS A' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const appA = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tsA}` },
        payload: { name: 'App A', slug: 'stats-a' },
      })
      .then((r) => (r.json().data as { id: string }).id);

    // Workspace B tries to read A's stats.
    const tsB = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: 'op-stats-b@example.com', password: 'pw-one-two-three', workspaceName: 'WS B' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appA}/stats`,
      headers: { authorization: `Bearer ${tsB}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
