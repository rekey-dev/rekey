/**
 * The Users overview reading the daily rollup: 366-day ranges, the
 * dimension breakdown, zone segments that never mix, and the fall back to
 * the live path's limits when the filters need it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { backfillApplication } from '../src/modules/analytics/rollup/backfill.js';
import { rollupApplication } from '../src/modules/analytics/rollup/job.js';
import { activeOn, seedUsers, shiftDay, utcToday, type SeedUser } from './analytics-seed.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';

type Json = Record<string, any>;

describe('users analytics: rollup read path', () => {
  let app: FastifyInstance;
  let w: OperatorWorld;
  let users: SeedUser[];
  const today = utcToday();

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await operatorWorld(app);
    users = await seedUsers(w.appId, 120, 31, 200);
  });

  const get = (qs: string) =>
    w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/analytics/users${qs}`, headers: bearer(w.ownerToken) });

  it('stays live, and caps at 63 days, until the rollup holds a day', async () => {
    const res = await get('?range=90d');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ANALYTICS_RANGE_TOO_LONG');
    expect(res.json().error.fix).toMatch(/holds no days/);
    const filtered = await get('?range=90d&createdVia=oauth&platform=ios&country=US');
    expect(filtered.statusCode).toBe(400);
    expect(filtered.json().error.fix).toMatch(/holds no days/);
    expect(filtered.json().error.fix).not.toMatch(/remove/i);
    expect((await get('?range=7d')).json().data.sections.kpis.source).toBe('live');
  });

  it('answers 366 days from the rollup, exact where the bits reached and null before', async () => {
    await backfillApplication(w.appId);
    await rollupApplication(w.appId);
    const res = await get(`?range=custom&from=${shiftDay(today, -365)}&to=${today}&compare=none&sections=kpis,activity,usage`);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as Json;
    expect(data.range).toMatchObject({ days: 366, timezone: 'UTC' });
    expect(data.coverage.rollupFrom).toBe(shiftDay(today, -366));
    const activity = data.sections.activity;
    expect(activity).toMatchObject({ source: 'rollup', timezone: 'UTC' });
    expect(activity.data.segments).toHaveLength(1);
    const points = activity.data.segments[0].points as Json[];
    expect(points).toHaveLength(366);
    for (const p of points) {
      const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${p.date}T00:00:00Z`)) / 86_400_000);
      if (age <= 62) expect(p.dau, p.date).toBe(users.filter((u) => activeOn(u, p.date)).length);
      else expect(p.dau).toBeNull();
      expect(p.accountsCreated, p.date).toBe(users.filter((u) => u.createdAt.toISOString().slice(0, 10) === p.date).length);
    }
    expect(data.sections.kpis.source).toBe('rollup');
    expect(data.sections.kpis.data.dau.value).toBe(users.filter((u) => activeOn(u, today)).length);
    expect(data.sections.kpis.data.dauAverage.value).toBeNull();
    expect(data.sections.kpis.gaps.map((g: Json) => g.reason)).toEqual(['not_in_rollup']);
    expectNullsExplained(activity, data.coverage);
  });

  it('a single dimension filter reads the breakdown; live-only filters keep the 63-day cap', async () => {
    await backfillApplication(w.appId);
    await rollupApplication(w.appId);
    const res = await get('?range=90d&platform=ios&sections=activity&compare=none');
    expect(res.statusCode, res.body).toBe(200);
    const points = res.json().data.sections.activity.data.segments[0].points as Json[];
    for (const p of points) {
      const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${p.date}T00:00:00Z`)) / 86_400_000);
      if (age <= 62) {
        expect(p.dau, p.date).toBe(users.filter((u) => u.platform === 'ios' && activeOn(u, p.date)).length);
        if (age <= 56) expect(p.wau, p.date).not.toBeNull();
      } else {
        expect(p.dau, `backfilled ${p.date}`).toBeNull();
        expect(p.wau).toBeNull();
      }
    }
    const blocked = await get('?range=90d&verified=true');
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.fix).toMatch(/Or remove the verified filter, so the daily rollup can answer it\.$/);
    expect((await get('?range=30d&platform=ios,web')).json().data.sections.kpis.source).toBe('rollup');
    expect((await get('?range=30d&platform=ios&country=DE')).json().data.sections.kpis.source).toBe('live');
  });

  it('splits days counted in two zones into two segments and says why', async () => {
    await prisma.application.update({ where: { id: w.appId }, data: { reportingTimezone: 'Asia/Kolkata' } });
    const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const rows = [];
    for (let i = 13; i >= 0; i--) {
      rows.push({
        applicationId: w.appId,
        day: new Date(`${shiftDay(localToday, -i)}T00:00:00Z`),
        timezone: i >= 5 ? 'UTC' : 'Asia/Kolkata',
        dau: 10 + i,
        final: i > 0,
      });
    }
    await prisma.applicationActivityDay.createMany({ data: rows });
    const data = (await get('?range=7d&compare=none&sections=activity')).json().data as Json;
    expect(data.range.timezone).toBe('Asia/Kolkata');
    const segments = data.sections.activity.data.segments as Json[];
    expect(segments.map((s) => s.timezone)).toEqual(['UTC', 'Asia/Kolkata']);
    expect(segments[0]!.to < segments[1]!.from).toBe(true);
    expect(segments[1]!.points.at(-1).dau).toBe(10);
    expect(data.coverage.timezoneNote).toMatch(/UTC \(through /);
  });

  it('usage, live sessions and adoption trend come from the rollup', async () => {
    const current = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
    await prisma.application.update({
      where: { id: w.appId },
      data: { billingConfig: { ...(current.billingConfig as object), enabled: true } },
    });
    const meter = await prisma.usageMeter.create({ data: { applicationId: w.appId, slug: 'api', name: 'API', unit: 'call' } });
    await prisma.applicationActivityDay.create({
      data: { applicationId: w.appId, day: new Date(`${shiftDay(today, -40)}T00:00:00Z`), timezone: 'UTC', final: true, usageByMeter: {} },
    });
    await prisma.usageRecord.create({
      data: { meterId: meter.id, endUserId: users[0]!.id, subjectKey: `u:${users[0]!.id}`, quantity: 5, occurredAt: new Date(`${shiftDay(today, -40)}T09:00:00Z`) },
    });
    await rollupApplication(w.appId);
    const data = (await get('?range=90d&sections=usage,mix,security')).json().data as Json;
    expect(data.sections.usage).toMatchObject({ source: 'rollup', data: { partial: true } });
    expect(data.sections.usage.data.meters).toEqual([{ meterId: meter.id, slug: 'api', name: 'API', unit: 'call', units: 5 }]);
    expect(data.sections.mix.data.liveSessions).toMatchObject({ takenOn: today });
    expect(data.sections.security.data.trend).toEqual([
      expect.objectContaining({ date: today, timezone: 'UTC', total: users.length }),
    ]);
  });

  it('the Overview /stats sums usage from the rollup once it holds 30 days', async () => {
    const meter = await prisma.usageMeter.create({ data: { applicationId: w.appId, slug: 'api', name: 'API', unit: 'call' } });
    await prisma.applicationActivityDay.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        applicationId: w.appId,
        day: new Date(`${shiftDay(today, -i)}T00:00:00Z`),
        timezone: 'UTC',
        final: i > 0,
        usageByMeter: { [meter.id]: 2 },
      })),
    });
    const stats = await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/stats`, headers: bearer(w.ownerToken) });
    expect(stats.json().data.usage.usageLast30d).toBe(60);
    await prisma.applicationActivityDay.deleteMany({ where: { applicationId: w.appId, day: new Date(`${today}T00:00:00Z`) } });
    const partial = await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/stats`, headers: bearer(w.ownerToken) });
    expect(partial.json().data.usage.usageLast30d).toBe(0);
  });

  it('with rollup rows present, a 30-day platform filter still answers WAU, MAU and stickiness', async () => {
    await backfillApplication(w.appId);
    await rollupApplication(w.appId);
    const data = (await get('?range=30d&platform=ios&sections=kpis,activity')).json().data as Json;
    const points = data.sections.activity.data.segments[0].points as Json[];
    for (const p of points) {
      expect(p.dau, p.date).toBe(users.filter((u) => u.platform === 'ios' && activeOn(u, p.date)).length);
      expect(p.wau, p.date).not.toBeNull();
      expect(p.mau, p.date).not.toBeNull();
    }
    expect(data.sections.kpis.data.wau.value).not.toBeNull();
    expect(data.sections.kpis.data.mau.value).not.toBeNull();
  });

  /** Every null DAU, WAU or MAU point sits on a day a gap or `rollupMissingDays` names for that metric. */
  function expectNullsExplained(section: Json, coverage: Json): void {
    const points = (section.data.segments as Json[]).flatMap((s) => s.points as Json[]);
    for (const p of points) {
      for (const m of ['dau', 'wau', 'mau']) {
        if (p[m] !== null) continue;
        const named = (section.gaps as Json[]).some((g) => g.metrics.includes(m) && g.days.includes(p.date));
        expect(named || coverage.rollupMissingDays.includes(p.date), `${m} on ${p.date}`).toBe(true);
      }
    }
  }

  it('a non-UTC Application under a platform filter reads WAU, MAU and stickiness from the rollup', async () => {
    await prisma.application.update({ where: { id: w.appId }, data: { reportingTimezone: 'Asia/Kolkata' } });
    const active = await Promise.all(
      ['ios', 'ios', 'android'].map((platform, i) =>
        prisma.endUser.create({ data: { applicationId: w.appId, email: `tz${i}@example.com`, lastPlatform: platform } }),
      ),
    );
    const far = new Date(Date.now() + 86_400_000);
    await prisma.refreshToken.createMany({
      data: active.map((u, i) => ({ applicationId: w.appId, endUserId: u.id, tokenHash: `tz${i}`, expiresAt: far, createdAt: new Date(Date.now() - 60_000) })),
    });
    for (const back of [6, 4, 2, 0]) await rollupApplication(w.appId, new Date(Date.now() - back * 86_400_000));
    const data = (await get('?range=7d&platform=ios&sections=kpis,activity&compare=none')).json().data as Json;
    const kpis = data.sections.kpis;
    expect(kpis).toMatchObject({ source: 'rollup', timezone: 'Asia/Kolkata', gaps: [] });
    expect(kpis.data.wau.value).toBe(2);
    expect(kpis.data.mau.value).toBe(2);
    expect(kpis.data.stickiness.value).not.toBeNull();
    expect(data.sections.activity.gaps).toEqual([]);
    expectNullsExplained(data.sections.activity, data.coverage);
  });

  it('a filtered metric the rollup cannot answer is null with a reason, and following its fix answers it', async () => {
    await backfillApplication(w.appId);
    await rollupApplication(w.appId);
    const wide = (await get('?range=90d&platform=ios&sections=kpis,activity&compare=none')).json().data as Json;
    const gap = (wide.sections.activity.gaps as Json[]).find((g) => g.reason === 'filter_not_in_rollup');
    expect(gap?.metrics).toEqual(expect.arrayContaining(['wau', 'mau']));
    expectNullsExplained(wide.sections.activity, wide.coverage);
    const kpiGap = (wide.sections.kpis.gaps as Json[]).find((g) => g.reason === 'filter_not_in_rollup');
    for (const [name, m] of Object.entries(wide.sections.kpis.data as Record<string, Json>)) {
      if (m.value === null) expect(kpiGap?.metrics, name).toContain(name);
    }
    expect(gap?.fix).toMatch(/last 30 days/);
    const narrow = (await get('?range=30d&platform=ios&sections=kpis,activity&compare=none')).json().data as Json;
    expect(narrow.sections.activity.gaps).toEqual([]);
    expect(narrow.sections.kpis.gaps).toEqual([]);
    for (const p of narrow.sections.activity.data.segments[0].points as Json[]) {
      expect([p.dau, p.wau, p.mau], p.date).not.toContain(null);
    }
  });

  it('a too-long live range names the filters to drop, and dropping exactly those answers it from the rollup', async () => {
    await rollupApplication(w.appId);
    const refused = await get('?range=90d&createdVia=oauth&verified=true&platform=ios&country=US&sections=kpis');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.fix).toBe(
      'Shorten the range to 63 days or less. Or remove the createdVia and verified filters and keep only one of the platform or country filters, so the daily rollup can answer it.',
    );
    const followed = await get('?range=90d&platform=ios&sections=kpis');
    expect(followed.statusCode, followed.body).toBe(200);
    expect(followed.json().data.sections.kpis.source).toBe('rollup');
  });

  it('a filtered gap on a local-zone day offers only removing the filter, and doing so answers it', async () => {
    await prisma.application.update({ where: { id: w.appId }, data: { reportingTimezone: 'Asia/Tokyo' } });
    const tokyoToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    await prisma.applicationActivityDay.createMany({
      data: Array.from({ length: 7 }, (_, i) => ({
        applicationId: w.appId,
        day: new Date(`${shiftDay(tokyoToday, -i)}T00:00:00Z`),
        timezone: 'Asia/Tokyo',
        dau: 3,
        wau: 4,
        mau: 5,
        breakdown: { platform: { ios: { dau: 1 } }, country: {}, via: {}, createdVia: {} },
      })),
    });
    const filtered = (await get('?range=7d&platform=ios&sections=kpis,activity&compare=none')).json().data as Json;
    for (const section of [filtered.sections.kpis, filtered.sections.activity]) {
      const gap = (section.gaps as Json[]).find((g) => g.reason === 'filter_not_in_rollup');
      expect(gap?.fix).toBe('Remove the platform, country or via filter.');
    }
    const unfiltered = (await get('?range=7d&sections=kpis,activity&compare=none')).json().data as Json;
    expect(unfiltered.sections.kpis.gaps).toEqual([]);
    expect(unfiltered.sections.kpis.data.wau.value).toBe(4);
  });

  it('a createdVia filter keeps its activity numbers (it is answered live)', async () => {
    await rollupApplication(w.appId);
    const data = (await get('?range=30d&createdVia=oauth&sections=kpis')).json().data as Json;
    expect(data.sections.kpis.source).toBe('live');
    expect(data.sections.kpis.data.dau.value).not.toBeNull();
  });

  it('snapshot-backed parts name the filters they ignore, and missing rollup days are listed', async () => {
    await rollupApplication(w.appId);
    const data = (await get('?range=7d&platform=ios&sections=mix,security')).json().data as Json;
    expect(data.sections.mix.data.liveSessions.ignoredFilters).toEqual(['platform']);
    expect(data.sections.security.data.trendIgnoredFilters).toEqual(['platform']);
    const wide = (await get('?range=30d&sections=kpis')).json().data as Json;
    expect(wide.coverage.rollupMissingDays).toEqual([]);
    await prisma.application.update({ where: { id: w.appId }, data: { reportingTimezone: 'Asia/Tokyo' } });
    await prisma.applicationActivityDay.deleteMany({ where: { applicationId: w.appId } });
    const tokyoToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
    await prisma.applicationActivityDay.create({ data: { applicationId: w.appId, day: new Date(`${shiftDay(tokyoToday, -3)}T00:00:00Z`), timezone: 'Asia/Tokyo', dau: 1 } });
    const gaps = (await get('?range=7d&sections=kpis')).json().data as Json;
    expect(gaps.coverage.rollupMissingDays).toEqual([shiftDay(tokyoToday, -2), shiftDay(tokyoToday, -1), tokyoToday]);
  });

  it('/stats counts usage recorded late, once the next rollup run has re-summed it', async () => {
    const meter = await prisma.usageMeter.create({ data: { applicationId: w.appId, slug: 'api', name: 'API', unit: 'call' } });
    await prisma.applicationActivityDay.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        applicationId: w.appId,
        day: new Date(`${shiftDay(today, -i)}T00:00:00Z`),
        timezone: 'UTC',
        final: i > 0,
        usageByMeter: {},
      })),
    });
    await prisma.usageRecord.create({
      data: { meterId: meter.id, endUserId: users[0]!.id, subjectKey: `u:${users[0]!.id}`, quantity: 9, occurredAt: new Date(`${shiftDay(today, -5)}T09:00:00Z`) },
    });
    await rollupApplication(w.appId);
    const stats = await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/stats`, headers: bearer(w.ownerToken) });
    expect(stats.json().data.usage.usageLast30d).toBe(9);
  });

  it('an Application whose stored zone the database does not know reads in UTC with a note, never a 500', async () => {
    await rollupApplication(w.appId);
    await prisma.application.update({ where: { id: w.appId }, data: { reportingTimezone: 'Asia/Calcutta' } });
    const [known] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_timezone_names WHERE name = 'Asia/Calcutta'`;
    const res = await get('?range=30d');
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as Json;
    for (const s of Object.values(data.sections) as Json[]) expect(['ok', 'unavailable']).toContain(s.status);
    if (Number(known?.n) === 0) {
      expect(data.range.timezone).toBe('UTC');
      expect(data.coverage.timezoneNote).toMatch(/does not know the reporting timezone Asia\/Calcutta/);
    }
  });
});
