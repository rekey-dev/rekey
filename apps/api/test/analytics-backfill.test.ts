/**
 * The rollup backfill: UTC days from what is still stored, exact where the
 * bits reach and null beyond, never over a row the job wrote, and a no-op
 * the second time.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { backfillAll, backfillApplication } from '../src/modules/analytics/rollup/backfill.js';
import { rollupApplication } from '../src/modules/analytics/rollup/job.js';
import { activeOn, activeWithin, seedUsers, shiftDay, utcToday, type SeedUser } from './analytics-seed.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';

describe('analytics rollup backfill', () => {
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
    users = await seedUsers(w.appId, 150, 13, 300);
  });

  const rows = async () =>
    new Map(
      (await prisma.applicationActivityDay.findMany({ where: { applicationId: w.appId } })).map((r) => [
        r.day.toISOString().slice(0, 10),
        r,
      ]),
    );

  it('fills 365 UTC days, exact inside the bits window and null outside', async () => {
    const written = await backfillApplication(w.appId);
    expect(written).toHaveLength(365);
    expect(written.at(-1)).toBe(shiftDay(today, -2));
    const byDay = await rows();
    for (const [day, row] of byDay) {
      expect(row).toMatchObject({ timezone: 'UTC', source: 'backfill', final: true });
      expect(row.newUsers, `new ${day}`).toBe(users.filter((u) => u.createdAt.toISOString().slice(0, 10) === day).length);
      const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
      if (age <= 62) expect(row.dau, `dau ${day}`).toBe(users.filter((u) => activeOn(u, day)).length);
      else expect(row.dau).toBeNull();
      if (age <= 56) expect(row.wau, `wau ${day}`).toBe(users.filter((u) => activeWithin(u, day, 7)).length);
      else expect(row.wau).toBeNull();
      if (age <= 33) expect(row.mau, `mau ${day}`).toBe(users.filter((u) => activeWithin(u, day, 30)).length);
      else expect(row.mau).toBeNull();
    }
  });

  it('matches the live path for the days they share', async () => {
    await backfillApplication(w.appId);
    const byDay = await rows();
    const res = await w.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}/analytics/users?range=30d&sections=activity&compare=none`,
      headers: bearer(w.ownerToken),
    });
    const points = res.json().data.sections.activity.data.segments[0].points as Array<{ date: string; dau: number; wau: number; mau: number; accountsCreated: number }>;
    for (const p of points.filter((x) => byDay.has(x.date))) {
      const r = byDay.get(p.date)!;
      expect({ dau: r.dau, wau: r.wau, mau: r.mau, n: r.newUsers }, p.date).toEqual({ dau: p.dau, wau: p.wau, mau: p.mau, n: p.accountsCreated });
    }
  });

  it('leaves days the job wrote alone, and a second run writes nothing', async () => {
    await rollupApplication(w.appId, new Date(`${today}T00:20:00Z`));
    const twoDaysAgo = new Date(`${shiftDay(today, -2)}T00:00:00Z`);
    await prisma.applicationActivityDay.create({
      data: { applicationId: w.appId, day: twoDaysAgo, timezone: 'Europe/Berlin', dau: 7, final: true },
    });
    await backfillApplication(w.appId);
    const byDay = await rows();
    expect(byDay.get(shiftDay(today, -2))).toMatchObject({ timezone: 'Europe/Berlin', dau: 7 });
    expect(byDay.get(shiftDay(today, -1))!.source).toBe('job');
    expect(await backfillApplication(w.appId)).toEqual([]);
    expect((await backfillAll()).days).toBe(0);
  });

  it('carries sign-ins by method from the event log', async () => {
    const day = shiftDay(today, -10);
    for (const via of ['password', 'passkey', 'passkey']) {
      await prisma.securityEvent.create({
        data: { type: 'user.signed_in', applicationId: w.appId, actorType: 'end_user', metadata: { via }, createdAt: new Date(`${day}T08:00:00Z`) },
      });
    }
    await backfillApplication(w.appId);
    const row = (await rows()).get(day)!;
    expect(row.signIns).toBe(3);
    expect((row.breakdown as { via: Record<string, { signIns?: number }> }).via.passkey?.signIns).toBe(2);
  });

  it('runs each Application under a statement budget and keeps going when one fails', async () => {
    const other = await operatorWorld(app);
    await seedUsers(other.appId, 10, 14, 30);
    const lines: string[] = [];
    const failing = await backfillAll({ statementTimeoutMs: 1, log: (l) => lines.push(l) });
    expect(failing).toMatchObject({ applications: 2, failed: 2, days: 0 });
    expect(lines.filter((l) => l.includes('failed, skipped (ANALYTICS_TIMEOUT'))).toHaveLength(2);
    const ok = await backfillAll();
    expect(ok).toMatchObject({ applications: 2, failed: 0 });
    expect(ok.days).toBe(730);
  });
});
