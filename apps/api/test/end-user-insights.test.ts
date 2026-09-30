/**
 * `GET /tenant/applications/:id/end-users/:euid/insights`, the data behind the
 * panel's end-user Overview, and the list columns it adds.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { groupSignInSources } from '../src/modules/end-users/insights.service.js';

const PASSWORD = 'pw-one-two-three';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

type Json = Record<string, unknown>;

describe('End-user insights', () => {
  let app: FastifyInstance;
  let operator: string;
  let appId: string;
  let secretKey: string;
  let publicKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const op = (): { authorization: string } => ({ authorization: `Bearer ${operator}` });

  beforeEach(async () => {
    const slug = `in-${Math.random().toString(36).slice(2, 8)}`;
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const created = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: op(), payload: { name: 'IN', slug } })
      .then((r) => r.json().data as { id: string; publicKey: string });
    appId = created.id;
    publicKey = created.publicKey;
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: op(),
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  });

  async function insights(euid: string): Promise<{ status: number; data: Json }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appId}/end-users/${euid}/insights`,
      headers: op(),
    });
    return { status: res.statusCode, data: (res.json().data ?? res.json()) as Json };
  }

  it('reports sign-ins, activity, platforms, sources, security and onboarding', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/profile-schema`,
      headers: op(),
      payload: {
        fields: [
          { key: 'company', label: 'Company', type: 'text', requiredForOnboarding: true },
          { key: 'role', label: 'Role', type: 'text', requiredForOnboarding: true },
        ],
      },
    });
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${publicKey}`, 'user-agent': CHROME_MAC, 'cf-ipcountry': 'DE' },
      payload: { email: 'ada@example.com', password: PASSWORD },
    });
    const euid = (signUp.json().data as { endUser: { id: string } }).endUser.id;
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${secretKey}` },
      payload: { email: 'ada@example.com', password: PASSWORD, client: { platform: 'ios', appVersion: '2.1.0' } },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${euid}/profile`,
      headers: { authorization: `Bearer ${secretKey}` },
      payload: { company: 'Analytical Engines' },
    });
    await prisma.oAuthIdentity.create({
      data: { applicationId: appId, endUserId: euid, provider: 'google', providerAccountId: 'g-1' },
    });
    await prisma.$executeRaw`
      UPDATE "end_users" SET "last_active_on" = (now() AT TIME ZONE 'UTC')::date,
             "activity_bits" = ${(0b1000101 + 2 ** 40).toString()}::bigint::bit(63)
       WHERE "id" = ${euid}`;

    const { status, data } = await insights(euid);
    expect(status).toBe(200);
    expect(data.signIns).toMatchObject({ count: 2, lastSignInVia: 'password', trackedSince: expect.any(String) });
    const activity = data.activity as {
      last30: boolean[];
      last63: boolean[];
      activeDaysLast7: number;
      activeDaysLast30: number;
    };
    expect(activity.last30).toHaveLength(30);
    expect(activity.last30.slice(-7)).toEqual([true, false, false, false, true, false, true]);
    expect(activity).toMatchObject({ activeDaysLast7: 3, activeDaysLast30: 3 });
    // Day 40 is outside the 30-day strip but inside the 63 days the bits remember.
    expect(activity.last63).toHaveLength(63);
    expect(activity.last63.slice(-30)).toEqual(activity.last30);
    expect(activity.last63[62 - 40]).toBe(true);
    expect(activity.last63.filter(Boolean)).toHaveLength(4);
    // No country: TRUST_CF_IPCOUNTRY is off by default (end-user-client-platform.test.ts covers it on).
    expect(data.platforms).toEqual({ last: 'ios', seen: ['web', 'ios'], lastCountry: null });
    const sources = data.sources as Json[];
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ platform: 'ios', appVersion: '2.1.0', country: null, live: true, sessions: 1 });
    expect(sources[1]).toMatchObject({ platform: 'web', os: 'macOS', browser: 'Chrome', country: null, live: true });
    expect(data.security).toEqual({ mfaEnabled: false, passkeys: 0, oauthProviders: ['google'] });
    expect(data.profile).toMatchObject({
      answers: { company: 'Analytical Engines' },
      onboardingCompletedAt: null,
      missingRequired: ['role'],
    });
    expect((data.profile as { fields: unknown[] }).fields).toHaveLength(2);
  });

  it('counts a session refreshed 40 times as one session', async () => {
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${publicKey}`, 'user-agent': CHROME_MAC },
      payload: { email: 'rotating@example.com', password: PASSWORD },
    });
    const data = signUp.json().data as { endUser: { id: string }; refreshToken: string };
    let refreshToken = data.refreshToken;
    for (let i = 0; i < 40; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { authorization: `Bearer ${publicKey}`, 'user-agent': CHROME_MAC },
        payload: { refreshToken },
      });
      expect(res.statusCode).toBe(200);
      refreshToken = (res.json().data as { refreshToken: string }).refreshToken;
    }
    expect(await prisma.refreshToken.count({ where: { endUserId: data.endUser.id } })).toBe(41);
    const { data: body } = await insights(data.endUser.id);
    expect(body.sources).toEqual([expect.objectContaining({ platform: 'web', browser: 'Chrome', sessions: 1, live: true })]);
  });

  it('a user who never signed in has empty insights, not errors', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: op(),
      payload: { email: 'quiet@example.com' },
    });
    const euid = (created.json().data as { id: string }).id;
    const { status, data } = await insights(euid);
    expect(status).toBe(200);
    expect(data.signIns).toMatchObject({ count: 0, lastSignedInAt: null, firstSignedInAt: null });
    expect((data.activity as { last30: boolean[] }).last30.every((d) => !d)).toBe(true);
    expect(data.sources).toEqual([]);
  });

  it("refuses another Application's user with END_USER_NOT_FOUND", async () => {
    const other = await prisma.endUser.create({
      data: {
        email: 'stranger@example.com',
        application: {
          create: {
            name: 'Other',
            slug: `other-${Math.random().toString(36).slice(2, 8)}`,
            publicKey: `rp_pub_other_${Math.random().toString(36).slice(2, 10)}`,
            authConfig: {},
            billingConfig: {},
            tenant: { create: { name: 'Other', ownerEmail: 'other@example.com' } },
          },
        },
      },
    });
    const { status, data } = await insights(other.id);
    expect(status).toBe(404);
    expect((data.error as { code: string }).code).toBe('END_USER_NOT_FOUND');
  });

  it('the end-user list carries lastPlatform and profile', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${publicKey}`, 'user-agent': CHROME_MAC },
      payload: { email: 'listed@example.com', password: PASSWORD },
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/tenant/applications/${appId}/end-users`, headers: op() });
    expect((res.json().data as { items: Json[] }).items[0]).toMatchObject({ lastPlatform: 'web', profile: {} });
  });

  describe('groupSignInSources', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    const row = (over: Partial<Parameters<typeof groupSignInSources>[0][number]>) => ({
      clientPlatform: null,
      clientOs: null,
      clientBrowser: null,
      clientAppVersion: null,
      country: null,
      userAgent: null,
      createdAt: new Date('2026-09-28T00:00:00Z'),
      revokedAt: null,
      expiresAt: new Date('2026-10-28T00:00:00Z'),
      ...over,
    });

    it('reads an older session from its User-Agent and merges it with a newer one of the same kind', () => {
      const sources = groupSignInSources(
        [
          row({ userAgent: CHROME_MAC, createdAt: new Date('2026-09-01T00:00:00Z'), revokedAt: new Date('2026-09-02T00:00:00Z') }),
          row({ clientPlatform: 'web', clientOs: 'macOS', clientBrowser: 'Chrome' }),
        ],
        now,
      );
      expect(sources).toEqual([
        expect.objectContaining({ platform: 'web', os: 'macOS', browser: 'Chrome', sessions: 2, live: true, lastSeenAt: '2026-09-28T00:00:00.000Z' }),
      ]);
    });

    it('keeps the five newest places', () => {
      const rows = ['DE', 'FR', 'IT', 'ES', 'NL', 'SE'].map((country, i) =>
        row({ clientPlatform: 'web', country, createdAt: new Date(Date.UTC(2026, 8, 1 + i)) }),
      );
      expect(groupSignInSources(rows, now).map((s) => s.country)).toEqual(['SE', 'NL', 'ES', 'IT', 'FR']);
    });
  });
});
