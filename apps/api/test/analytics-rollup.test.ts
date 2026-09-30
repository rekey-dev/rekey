/**
 * The analytics rollup job: a UTC day matches the live path, a local day
 * counts sessions in its own window, final days are never rewritten, the
 * lease and hour marker keep it to one run, and one failing Application
 * does not stop the rest.
 */

import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { rollupApplication, runAnalyticsRollup } from '../src/modules/analytics/rollup/job.js';
import { localMidnight } from '../src/modules/analytics/rollup/day-window.js';
import { activeOn, activeWithin, seedUsers, shiftDay, utcToday, type SeedUser } from './analytics-seed.js';
import { operatorWorld, type OperatorWorld } from './operator-world.js';
import { recordStatements, seqScansOnBigTables } from './analytics-explain.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const silent = { info: () => undefined, warn: () => undefined };

describe('analytics rollup job', () => {
  let app: FastifyInstance;
  let w: OperatorWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await operatorWorld(app);
  });

  const rowFor = (day: string) =>
    prisma.applicationActivityDay.findUniqueOrThrow({
      where: { applicationId_day: { applicationId: w.appId, day: new Date(`${day}T00:00:00Z`) } },
    });

  describe('a UTC Application', () => {
    let users: SeedUser[];
    beforeEach(async () => {
      users = await seedUsers(w.appId, 150, 5, 60);
    });

    it('writes yesterday and today exactly as the live path counts them', async () => {
      const today = utcToday();
      const written = await rollupApplication(w.appId);
      expect(written).toEqual([shiftDay(today, -1), today]);
      for (const day of written) {
        const row = await rowFor(day);
        expect(row.timezone).toBe('UTC');
        expect(row.dau, `dau ${day}`).toBe(users.filter((u) => activeOn(u, day)).length);
        expect(row.wau).toBe(users.filter((u) => activeWithin(u, day, 7)).length);
        expect(row.mau).toBe(users.filter((u) => activeWithin(u, day, 30)).length);
        expect(row.newUsers).toBe(users.filter((u) => u.createdAt.toISOString().slice(0, 10) === day).length);
        const platform = (row.breakdown as { platform: Record<string, { dau?: number }> }).platform;
        expect(platform.ios?.dau ?? 0).toBe(users.filter((u) => u.platform === 'ios' && activeOn(u, day)).length);
      }
      const snap = await prisma.applicationPopulationSnapshot.findUniqueOrThrow({
        where: { applicationId_takenOn: { applicationId: w.appId, takenOn: new Date(`${today}T00:00:00Z`) } },
      });
      expect(snap.total).toBe(users.length);
      expect(snap.erased).toBe(users.filter((u) => u.erased).length);
      expect(snap.verified).toBe(users.filter((u) => u.verified).length);
      expect((snap.cube as Array<{ n: number }>).reduce((s, c) => s + c.n, 0)).toBe(users.length);
      expect(snap.onboarding).toEqual({
        completed: users.filter((u) => u.onboardingCompletedAt).length,
        skipped: users.filter((u) => !u.onboardingCompletedAt && u.onboardingSkippedAt).length,
        pending: users.filter((u) => !u.onboardingCompletedAt && !u.onboardingSkippedAt).length,
      });
    });

    it('is idempotent, marks a finished day final, and never rewrites a final day', async () => {
      const today = utcToday();
      const yesterday = shiftDay(today, -1);
      const now = new Date(`${today}T00:20:00Z`);
      await rollupApplication(w.appId, now);
      const first = await rowFor(yesterday);
      expect(first.final).toBe(true);
      expect((await rowFor(today)).final).toBe(false);
      await prisma.applicationActivityDay.update({
        where: { applicationId_day: { applicationId: w.appId, day: first.day } },
        data: { dau: 999_999 },
      });
      await rollupApplication(w.appId, now);
      expect((await rowFor(yesterday)).dau).toBe(999_999);
      const todayBefore = await rowFor(today);
      await rollupApplication(w.appId, now);
      const todayAfter = await rowFor(today);
      expect({ ...todayAfter, computedAt: null }).toEqual({ ...todayBefore, computedAt: null });
    });

    it('counts live sessions by client attribute', async () => {
      const [a, b] = users;
      const far = new Date(Date.now() + 86_400_000);
      await prisma.refreshToken.createMany({
        data: [
          { applicationId: w.appId, endUserId: a!.id, tokenHash: 'h1', expiresAt: far, clientPlatform: 'ios', clientOs: 'iOS', clientAppVersion: '4.2.0' },
          { applicationId: w.appId, endUserId: b!.id, tokenHash: 'h2', expiresAt: far, clientPlatform: 'web', clientOs: 'macOS', clientBrowser: 'Safari' },
          { applicationId: w.appId, endUserId: b!.id, tokenHash: 'h3', expiresAt: far, clientPlatform: 'web', revokedAt: new Date() },
          { applicationId: w.appId, endUserId: b!.id, tokenHash: 'h4', expiresAt: new Date(Date.now() - 1000), clientPlatform: 'web' },
        ],
      });
      await rollupApplication(w.appId);
      const snap = await prisma.applicationPopulationSnapshot.findFirstOrThrow({ where: { applicationId: w.appId } });
      expect(snap.liveSessions).toEqual({
        platform: { ios: 1, web: 1 },
        os: { iOS: 1, macOS: 1 },
        browser: { Safari: 1, unknown: 1 },
        appVersion: { '4.2.0': 1, unknown: 1 },
      });
    });
  });

  describe('a non-UTC Application', () => {
    it('counts users with a session in the local day window, labelled with the zone', async () => {
      await prisma.application.update({ where: { id: w.appId }, data: { reportingTimezone: 'Asia/Kolkata' } });
      const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      const start = localMidnight(localToday, 'Asia/Kolkata');
      const users = await Promise.all(
        ['in1', 'in2', 'before', 'mcp'].map((tag) =>
          prisma.endUser.create({
            data: { applicationId: w.appId, email: `${tag}@example.com`, lastActiveOn: new Date(`${utcToday()}T00:00:00Z`) },
          }),
        ),
      );
      const far = new Date(Date.now() + 86_400_000);
      await prisma.refreshToken.createMany({
        data: [
          { applicationId: w.appId, endUserId: users[0]!.id, tokenHash: 'k1', expiresAt: far, createdAt: new Date(start.getTime() + 60_000) },
          { applicationId: w.appId, endUserId: users[1]!.id, tokenHash: 'k2', expiresAt: far, createdAt: new Date(start.getTime() + 1) },
          { applicationId: w.appId, endUserId: users[2]!.id, tokenHash: 'k3', expiresAt: far, createdAt: new Date(start.getTime() - 60_000) },
          { applicationId: w.appId, endUserId: users[3]!.id, tokenHash: 'k4', expiresAt: far, createdAt: new Date(start.getTime() + 5), kind: 'mcp', clientId: 'agent' },
        ],
      });
      const now = new Date(Math.max(Date.now(), start.getTime() + 120_000));
      await rollupApplication(w.appId, now);
      const row = await rowFor(localToday);
      expect(row.timezone).toBe('Asia/Kolkata');
      expect(row.dau).toBe(3);
      expect(row.wau).toBe(4);
    });

    it('a timezone change leaves final days in the zone they were computed in', async () => {
      const today = utcToday();
      await seedUsers(w.appId, 20, 9, 10);
      await rollupApplication(w.appId, new Date(`${today}T00:20:00Z`));
      expect((await rowFor(shiftDay(today, -1))).timezone).toBe('UTC');
      await prisma.application.update({ where: { id: w.appId }, data: { reportingTimezone: 'America/Los_Angeles' } });
      await rollupApplication(w.appId, new Date(`${today}T09:00:00Z`));
      const yesterday = await rowFor(shiftDay(today, -1));
      expect(yesterday.timezone).toBe('UTC');
      expect(yesterday.final).toBe(true);
    });
  });

  describe('late data and scale', () => {
    it('usage recorded late for a final day reaches that day on the next run', async () => {
      const today = utcToday();
      const users = await seedUsers(w.appId, 5, 6, 3);
      const meter = await prisma.usageMeter.create({ data: { applicationId: w.appId, slug: 'api', name: 'API', unit: 'call' } });
      const tenDaysAgo = shiftDay(today, -10);
      await prisma.applicationActivityDay.create({
        data: { applicationId: w.appId, day: new Date(`${tenDaysAgo}T00:00:00Z`), timezone: 'UTC', final: true, usageByMeter: {} },
      });
      await prisma.usageRecord.create({
        data: { meterId: meter.id, endUserId: users[0]!.id, subjectKey: `u:${users[0]!.id}`, quantity: 7, occurredAt: new Date(`${tenDaysAgo}T12:00:00Z`) },
      });
      await rollupApplication(w.appId);
      expect((await rowFor(tenDaysAgo)).usageByMeter).toEqual({ [meter.id]: 7 });
      expect((await rowFor(tenDaysAgo)).final).toBe(true);
    });

    it('the usage re-sum reads under the statement budget', async () => {
      await prisma.usageMeter.create({ data: { applicationId: w.appId, slug: 'api', name: 'API', unit: 'call' } });
      await prisma.applicationActivityDay.create({
        data: { applicationId: w.appId, day: new Date(`${shiftDay(utcToday(), -3)}T00:00:00Z`), timezone: 'UTC', final: true, usageByMeter: {} },
      });
      const statements = await recordStatements(() => rollupApplication(w.appId));
      const sums = statements.flatMap((q, i) => (q.includes('"usage_records"') && q.includes('sum(') ? [i] : []));
      const sum = sums[sums.length - 1] ?? -1;
      expect(sum).toBeGreaterThan(0);
      const opener = statements.slice(0, sum).reverse().find((q) => /statement_timeout|^\s*(BEGIN|COMMIT)/i.test(q));
      expect(opener).toMatch(/statement_timeout/);
    });

    it('a non-UTC day is counted in one range scan over the window, not a probe per user', async () => {
      await prisma.application.update({ where: { id: w.appId }, data: { reportingTimezone: 'Asia/Tokyo' } });
      await seedUsers(w.appId, 20, 7, 10);
      const statements = await recordStatements(() => rollupApplication(w.appId));
      const sessions = statements.filter((q) => q.includes('"refresh_tokens"') && !q.includes('"replaced_by_id"'));
      expect(sessions.length).toBeGreaterThan(0);
      for (const q of sessions) expect(q).not.toMatch(/"end_user_id"\s*=\s*c\."id"/);
      expect(await seqScansOnBigTables(sessions)).toEqual([]);
    });
  });

  describe('a timezone change', () => {
    it('computes the new zone\'s days straight away', async () => {
      await seedUsers(w.appId, 10, 12, 5);
      const res = await w.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${w.appId}/settings`,
        headers: { authorization: `Bearer ${w.ownerToken}` },
        payload: { reportingTimezone: 'Asia/Tokyo' },
      });
      expect(res.statusCode).toBe(200);
      const tokyoToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
      let row = null;
      for (let i = 0; i < 50 && !row; i++) {
        row = await prisma.applicationActivityDay.findUnique({
          where: { applicationId_day: { applicationId: w.appId, day: new Date(`${tokyoToday}T00:00:00Z`) } },
        });
        if (!row) await new Promise((r) => setTimeout(r, 100));
      }
      expect(row?.timezone).toBe('Asia/Tokyo');
    });
  });

  it('an Application whose stored zone the database does not know is rolled up in UTC', async () => {
    await seedUsers(w.appId, 5, 15, 5);
    await prisma.application.update({ where: { id: w.appId }, data: { reportingTimezone: 'Asia/Calcutta' } });
    const known = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_timezone_names WHERE name = 'Asia/Calcutta'`;
    await rollupApplication(w.appId);
    const row = await rowFor(utcToday());
    expect(row.timezone).toBe(Number(known[0]?.n) > 0 ? 'Asia/Calcutta' : 'UTC');
  });

  describe('the job', () => {
    let redis: Redis;
    beforeAll(() => {
      redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    });
    afterAll(async () => {
      await redis.quit();
    });

    it('runs on one replica at a time and once per hour', async () => {
      await seedUsers(w.appId, 10, 1, 5);
      const leaseKey = `lease:analytics-rollup:test:${Math.random()}`;
      const now = new Date();
      await redis.del(`rk:an:rollup:hour:${now.toISOString().slice(0, 13)}`);
      const racers = await Promise.all(
        Array.from({ length: 8 }, () => runAnalyticsRollup(redis, { log: silent, now, leaseKey })),
      );
      expect(racers.filter((r) => r.status === 'ran')).toHaveLength(1);
      expect(racers.filter((r) => r.status === 'held')).toHaveLength(7);
      const again = await runAnalyticsRollup(redis, { log: silent, now, leaseKey });
      expect(again).toMatchObject({ status: 'ran', result: { skippedHour: true } });
      await redis.del(`rk:an:rollup:hour:${now.toISOString().slice(0, 13)}`);
    });

    it('one failing Application does not stop the others', async () => {
      await seedUsers(w.appId, 10, 2, 5);
      const other = await operatorWorld(app);
      await seedUsers(other.appId, 10, 3, 5);
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION rk_test_refuse_rollup() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.application_id = '${other.appId}' THEN RAISE EXCEPTION 'refused for the test'; END IF;
          RETURN NEW;
        END $$`);
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER rk_test_refuse_rollup BEFORE INSERT ON application_activity_days FOR EACH ROW EXECUTE FUNCTION rk_test_refuse_rollup()',
      );
      let out;
      try {
        out = await runAnalyticsRollup(null, { log: silent });
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS rk_test_refuse_rollup ON application_activity_days');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS rk_test_refuse_rollup()');
      }
      expect(out).toMatchObject({ status: 'ran', result: { applications: 2, failed: 1 } });
      expect(await prisma.applicationActivityDay.count({ where: { applicationId: w.appId } })).toBe(2);
      expect(await prisma.applicationActivityDay.count({ where: { applicationId: other.appId } })).toBe(0);
    });
  });
});
