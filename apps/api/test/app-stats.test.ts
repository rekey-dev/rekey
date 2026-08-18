/**
 * Per-app Overview stats endpoint — GET /tenant/applications/:id/stats.
 *
 * Asserts the aggregation shape: end-user totals + a 30-day gap-filled sign-up
 * trend, the billing snapshot (off by default for new apps), and that the
 * counts are scoped to the calling Application.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

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

    // End-user totals (direct counts — deterministic).
    expect(stats.users.total).toBe(2);
    expect(stats.users.newLast7d).toBe(2);
    expect(stats.users.signupTrend).toHaveLength(30);
    // Last bucket is today and should hold both of today's sign-ups.
    expect(stats.users.signupTrend[29]!.count).toBe(2);

    // Billing snapshot — new apps default OFF.
    expect(stats.billing.enabled).toBe(false);
    expect(stats.billing.activeSubscriptions).toBe(0);
    expect(stats.billing.plansTotal).toBe(0);

    // Usage roll-up present + zeroed for a fresh app.
    expect(stats.usage.creditsOutstanding).toBe(0);
    expect(stats.usage.usageLast30d).toBe(0);

    // Security summary captured the two sign-ups (awaited above).
    expect(stats.security.signUpsLast30d).toBeGreaterThanOrEqual(2);
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
