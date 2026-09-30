/**
 * `GET /api/v1/tenant/applications/:id/analytics/users`, sections kpis and
 * activity on the live path: numbers against a brute-force oracle, the
 * window edges, the scope matrix, and the per-section failure envelope.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { dashboardSlots } from '../src/lib/compute-semaphore.js';
import { __setSectionDelayForTests } from '../src/modules/analytics/envelope.js';
import { activeOn, activeWithin, seedUsers, shiftDay, utcToday, type SeedUser } from './analytics-seed.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';

type Json = Record<string, any>;

describe('users analytics: kpis and activity (live)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => __setSectionDelayForTests({}));

  const url = (w: OperatorWorld, qs = ''): string => `/api/v1/tenant/applications/${w.appId}/analytics/users${qs}`;
  const get = (w: OperatorWorld, qs = '', token = w.ownerToken) =>
    w.inject({ method: 'GET', url: url(w, qs), headers: bearer(token) });

  function oracle(users: SeedUser[], pred: (u: SeedUser) => boolean) {
    const pop = users.filter(pred);
    return {
      dau: (d: string) => pop.filter((u) => activeOn(u, d)).length,
      wau: (d: string) => pop.filter((u) => activeWithin(u, d, 7)).length,
      mau: (d: string) => pop.filter((u) => activeWithin(u, d, 30)).length,
      created: (d: string) => pop.filter((u) => u.createdAt.toISOString().slice(0, 10) === d).length,
      before: (d: string) => pop.filter((u) => u.createdAt.toISOString().slice(0, 10) < d).length,
    };
  }

  describe('numbers', () => {
    let w: OperatorWorld;
    let users: SeedUser[];
    const today = utcToday();

    beforeEach(async () => {
      w = await operatorWorld(app);
      users = await seedUsers(w.appId, 240, 7);
    });

    const cases: Array<[string, string, (u: SeedUser) => boolean]> = [
      ['no filter', '', () => true],
      ['platform', '&platform=ios', (u) => u.platform === 'ios'],
      ['platform, two values', '&platform=web,ios', (u) => u.platform === 'web' || u.platform === 'ios'],
      ['verified', '&verified=true', (u) => u.verified],
      ['country and onboarding', '&country=de&onboarding=completed', (u) => u.country === 'DE' && u.onboardingCompletedAt !== null],
      ['skipped', '&onboarding=skipped', (u) => u.onboardingSkippedAt !== null && u.onboardingCompletedAt === null],
      ['createdVia oauth', '&createdVia=oauth', (u) => (u.createdVia ?? '').startsWith('oauth')],
      ['createdVia unknown', '&createdVia=unknown', (u) => u.createdVia === null],
      ['via', '&via=passkey,magic_link', (u) => u.via === 'passkey' || u.via === 'magic_link'],
    ];

    it.each(cases)('activity series matches the oracle: %s', async (_label, qs, pred) => {
      const res = await get(w, `?range=30d${qs}`);
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data as Json;
      const o = oracle(users, pred);
      const activity = data.sections.activity;
      expect(activity.status).toBe('ok');
      expect(activity.timezone).toBe('UTC');
      expect(activity.source).toBe('live');
      const seg = activity.data.segments[0];
      expect(activity.data.segments).toHaveLength(1);
      expect(seg.points).toHaveLength(30);
      for (const p of seg.points) {
        expect(p.dau, `dau ${p.date}`).toBe(o.dau(p.date));
        expect(p.wau, `wau ${p.date}`).toBe(o.wau(p.date));
        expect(p.mau, `mau ${p.date}`).toBe(o.mau(p.date));
        expect(p.accountsCreated, `created ${p.date}`).toBe(o.created(p.date));
        expect(p.previous.date).toBe(shiftDay(p.date, -30));
        expect(p.previous.dau, `prev dau ${p.previous.date}`).toBe(o.dau(p.previous.date));
      }
      expect(activity.data.accountsBefore).toBe(o.before(data.range.from));
    });

    it.each(cases)('kpis match the oracle: %s', async (_label, qs, pred) => {
      const res = await get(w, `?range=7d${qs}`);
      const data = res.json().data as Json;
      const k = data.sections.kpis.data;
      const o = oracle(users, pred);
      const pop = users.filter(pred);
      const from = shiftDay(today, -6);
      expect(k.totalUsers.value).toBe(pop.length);
      expect(k.totalUsers.erased).toBe(pop.filter((u) => u.erased).length);
      expect(k.totalUsers.previous).toBe(o.before(from));
      expect(k.newUsers.value).toBe(pop.filter((u) => u.createdAt.toISOString().slice(0, 10) >= from).length);
      expect(k.dau.value).toBe(o.dau(today));
      expect(k.dau.previous).toBe(o.dau(shiftDay(today, -7)));
      expect(k.wau.value).toBe(o.wau(today));
      expect(k.mau.value).toBe(o.mau(today));
      expect(k.mau.delta).toBe(o.mau(today) - o.mau(shiftDay(today, -7)));
      const avg = [0, 1, 2, 3, 4, 5, 6].reduce((s, i) => s + o.dau(shiftDay(today, -i)), 0) / 7;
      expect(k.dauAverage.value).toBeCloseTo(avg, 10);
      expect(k.stickiness.value).toBe(o.mau(today) === 0 ? null : avg / o.mau(today));
    });

    it('erased users stay in the total and are reported beside it', async () => {
      const data = (await get(w, '?range=7d')).json().data as Json;
      expect(data.sections.kpis.data.totalUsers.value).toBe(users.length);
      expect(data.sections.kpis.data.totalUsers.erased).toBe(users.filter((u) => u.erased).length);
      expect(data.sections.kpis.data.totalUsers.erased).toBeGreaterThan(0);
    });

    it('paying users count distinct owners of live subscriptions', async () => {
      const plan = await prisma.plan.create({
        data: { applicationId: w.appId, slug: 'pro', name: 'Pro', amount: 1000, currency: 'usd', interval: 'MONTH' },
      });
      const owners = users.slice(0, 3);
      for (const [i, u] of owners.entries()) {
        await prisma.subscription.create({
          data: { applicationId: w.appId, endUserId: u.id, planId: plan.id, status: (['ACTIVE', 'TRIALING', 'PAST_DUE'] as const)[i]! },
        });
      }
      await prisma.subscription.create({
        data: { applicationId: w.appId, endUserId: users[4]!.id, planId: plan.id, status: 'CANCELED' },
      });
      const k = (await get(w, '?range=7d&sections=kpis')).json().data.sections.kpis.data;
      expect(k.payingUsers.value).toBe(3);
      expect(k.conversion.value).toBeCloseTo(3 / users.length, 10);
      const paying = (await get(w, `?range=7d&sections=kpis&plan=${plan.id}`)).json().data.sections.kpis.data;
      expect(paying.totalUsers.value).toBe(3);
      const notPaying = (await get(w, '?range=7d&sections=kpis&paying=false')).json().data.sections.kpis.data;
      expect(notPaying.totalUsers.value).toBe(users.length - 3);
    });

    it('sign-ins by method come from the last 7 days of the event log, and only `via` applies', async () => {
      const at = new Date(`${today}T01:00:00Z`);
      for (const via of ['password', 'password', 'passkey']) {
        await prisma.securityEvent.create({
          data: { type: 'user.signed_in', applicationId: w.appId, actorType: 'end_user', actorId: users[0]!.id, metadata: { via }, createdAt: at },
        });
      }
      const res = await get(w, '?range=30d&sections=activity&platform=ios');
      const signIns = res.json().data.sections.activity.data.signIns;
      expect(signIns).toMatchObject({ status: 'ok', timezone: 'UTC', partial: true, ignoredFilters: ['platform'] });
      expect(signIns.points).toHaveLength(7);
      expect(signIns.points.at(-1)).toEqual({ date: today, total: 3, byVia: { password: 2, passkey: 1 } });
      const viaOnly = (await get(w, '?range=7d&sections=activity&via=passkey')).json().data.sections.activity.data.signIns;
      expect(viaOnly.points.at(-1)).toEqual({ date: today, total: 1, byVia: { passkey: 1 } });
    });
  });

  describe('window edges', () => {
    it('DAU is exact for 63 days, WAU for 57, MAU for 34, and null before', async () => {
      const w = await operatorWorld(app);
      const today = utcToday();
      const res = await get(w, `?range=custom&from=${shiftDay(today, -62)}&to=${today}&compare=none`);
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data as Json;
      const points = data.sections.activity.data.segments[0].points as Json[];
      expect(points).toHaveLength(63);
      expect(points[0]!.dau).toBe(0);
      expect(points[5]!.wau).toBeNull();
      expect(points[6]!.wau).toBe(0);
      expect(points[28]!.mau).toBeNull();
      expect(points[29]!.mau).toBe(0);
      expect(points[0]!.previous).toBeNull();
      expect(data.coverage).toMatchObject({
        activityFrom: shiftDay(today, -62),
        wauFrom: shiftDay(today, -56),
        mauFrom: shiftDay(today, -33),
        rollupFrom: null,
        timezone: 'UTC',
        timezoneNote: null,
      });
      const k = data.sections.kpis.data;
      expect(k.dau.previous).toBeNull();
      expect(k.newUsers.previous).toBeNull();
    });

    it('clips to activityTrackedSince when tracking began after the app existed', async () => {
      const w = await operatorWorld(app);
      const today = utcToday();
      await prisma.application.update({
        where: { id: w.appId },
        data: { createdAt: new Date(`${shiftDay(today, -200)}T00:00:00Z`), activityTrackedSince: new Date(`${shiftDay(today, -10)}T12:00:00Z`) },
      });
      const data = (await get(w, '?range=30d&compare=none')).json().data as Json;
      const points = data.sections.activity.data.segments[0].points as Json[];
      const byDay = new Map(points.map((p) => [p.date, p]));
      expect(byDay.get(shiftDay(today, -11))!.dau).toBeNull();
      expect(byDay.get(shiftDay(today, -10))!.dau).toBe(0);
      expect(byDay.get(shiftDay(today, -5))!.wau).toBeNull();
      expect(byDay.get(shiftDay(today, -4))!.wau).toBe(0);
      expect(data.coverage.activityFrom).toBe(shiftDay(today, -10));
      expect(data.coverage.trackedSince).toBe(shiftDay(today, -10));
    });

    it('an empty Application answers zeros, not errors', async () => {
      const w = await operatorWorld(app);
      const data = (await get(w, '')).json().data as Json;
      expect(data.sections.kpis.status).toBe('ok');
      expect(data.sections.kpis.data.totalUsers).toMatchObject({ value: 0, previous: 0, delta: 0, erased: 0 });
      expect(data.sections.kpis.data.stickiness.value).toBeNull();
    });

    it('a non-UTC reporting timezone is named, and the live numbers stay UTC', async () => {
      const w = await operatorWorld(app);
      await prisma.application.update({ where: { id: w.appId }, data: { reportingTimezone: 'Asia/Kolkata' } });
      const data = (await get(w, '?range=7d')).json().data as Json;
      expect(data.range.timezone).toBe('UTC');
      expect(data.coverage.timezone).toBe('Asia/Kolkata');
      expect(data.coverage.timezoneNote).toMatch(/UTC/);
      expect(data.sections.activity.timezone).toBe('UTC');
    });
  });

  describe('validation', () => {
    let w: OperatorWorld;
    beforeEach(async () => {
      w = await operatorWorld(app);
    });

    it.each([
      ['?range=custom&from=2026-05-02&to=2026-05-01', 'ANALYTICS_RANGE_INVALID'],
      ['?range=custom&from=2026-02-30&to=2026-03-01', 'ANALYTICS_RANGE_INVALID'],
      ['?range=custom&from=2026-01-01', 'ANALYTICS_RANGE_INVALID'],
      [`?range=custom&from=${utcToday()}&to=${shiftDay(utcToday(), 1)}`, 'ANALYTICS_RANGE_INVALID'],
      ['?range=30d&from=2026-01-01', 'ANALYTICS_RANGE_INVALID'],
      ['?range=90d', 'ANALYTICS_RANGE_TOO_LONG'],
      ['?range=bogus', 'VALIDATION_ERROR'],
      ['?platform=amiga', 'VALIDATION_ERROR'],
      ['?country=DEU', 'VALIDATION_ERROR'],
      ['?nonsense=1', 'VALIDATION_ERROR'],
      ['?sections=kpis,mystery', 'VALIDATION_ERROR'],
      ['?createdVia=oauth:', 'VALIDATION_ERROR'],
    ])('%s is refused with %s', async (qs, code) => {
      const res = await get(w, qs);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe(code);
      expect(res.json().error.fix).toBeTruthy();
    });

    it('the too-long fix names the limit', async () => {
      const res = await get(w, '?range=90d');
      expect(res.json().error.fix).toMatch(/63 days/);
    });
  });

  describe('access', () => {
    it('walks the role and scope matrix', async () => {
      const w = await operatorWorld(app, 'APP_VIEWER');
      const asMember = (qs = '') => get(w, qs, w.memberToken);

      expect((await get(w)).statusCode).toBe(200);
      for (const role of ['APP_VIEWER', 'APP_BILLING', 'APP_ADMIN'] as const) {
        await w.grant(role);
        const r = await asMember();
        expect(r.statusCode, `${role}: ${r.body}`).toBe(200);
        expect(r.json().data.sections.kpis.status).toBe('ok');
      }

      await w.setScopes(['overview:read']);
      expect((await asMember()).statusCode).toBe(200);
      const plan = await asMember('?paying=true');
      expect(plan.statusCode).toBe(403);
      expect(plan.json().error.code).toBe('SCOPE_INSUFFICIENT');
      const org = await asMember('?org=anything');
      expect(org.statusCode).toBe(403);

      await w.setScopes(['end-users:read']);
      const none = await asMember();
      expect(none.statusCode).toBe(403);
      expect(none.json().error.code).toBe('SCOPE_INSUFFICIENT');
    });

    it('refuses another Application\'s plan and organization with 404', async () => {
      const w = await operatorWorld(app);
      const other = await operatorWorld(app);
      const plan = await prisma.plan.create({
        data: { applicationId: other.appId, slug: 'x', name: 'X', amount: 100, currency: 'usd', interval: 'MONTH' },
      });
      const org = await prisma.organization.create({ data: { applicationId: other.appId, name: 'Other', slug: 'other' } });
      const p = await get(w, `?plan=${plan.id}`);
      expect(p.statusCode).toBe(404);
      expect(p.json().error.code).toBe('PLAN_NOT_FOUND');
      const o = await get(w, `?org=${org.id}`);
      expect(o.statusCode).toBe(404);
      expect(o.json().error.code).toBe('ORGANIZATION_NOT_FOUND');
      const cross = await other.inject({ method: 'GET', url: url(w), headers: bearer(other.ownerToken) });
      expect(cross.statusCode).toBe(404);
    });

    it('a member with no grant on the Application gets 404', async () => {
      const w = await operatorWorld(app);
      const second = await w.inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: bearer(w.ownerToken),
        payload: { name: 'second', slug: `second-${Math.random().toString(36).slice(2, 7)}` },
      });
      const secondId = second.json().data.id as string;
      const res = await w.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${secondId}/analytics/users`,
        headers: bearer(w.memberToken),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('resilience', () => {
    it('a section over its statement budget fails alone', async () => {
      const w = await operatorWorld(app);
      __setSectionDelayForTests({ kpis: 6_000 });
      const res = await get(w, '?range=7d');
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data as Json;
      expect(data.sections.kpis).toEqual({
        status: 'error',
        error: { code: 'ANALYTICS_TIMEOUT', message: expect.any(String), fix: 'Narrow the range or remove a filter.' },
      });
      expect(data.sections.activity.status).toBe('ok');
    }, 30_000);

    it('503 ANALYTICS_BUSY with Retry-After when every section waited for a slot', async () => {
      const w = await operatorWorld(app);
      const releases: Array<() => void> = [];
      const holders = [0, 1].map(() => dashboardSlots.run(() => new Promise<void>((r) => releases.push(r))));
      try {
        const res = await get(w, '?range=7d');
        expect(res.statusCode, res.body).toBe(503);
        expect(res.json().error.code).toBe('ANALYTICS_BUSY');
        expect(res.headers['retry-after']).toBe('5');
      } finally {
        releases.forEach((r) => r());
        await Promise.all(holders);
      }
    }, 30_000);
  });
});
