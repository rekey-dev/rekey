/**
 * Fill `application_activity_days` for the days before the rollup started,
 * from what is still stored. Every backfilled day is a UTC day
 * (`timezone: 'UTC'`, `source: 'backfill'`, `final: true`), whatever the
 * Application's reporting timezone: the activity bits are UTC and nothing
 * finer survives for old days.
 *
 * What each day can hold:
 *   - DAU for the last 63 days, WAU for the last 57, MAU for the last 34
 *     (the bits' window); older days keep them null, never guessed.
 *   - accounts created (and verified), per platform, country and source, for
 *     up to 366 days;
 *   - sign-ins by method for as far back as `security_events` still holds;
 *   - onboarding completions and skips, and usage by meter.
 *
 * A day that already has a row is left alone, so the job's rows win and a
 * second run writes nothing. Yesterday and today belong to the job.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { withReadOnlyBudget } from '../../../lib/read-budget.js';
import { liveActivityCounts } from '../live-activity.js';
import { addDays, eachDay } from '../range.js';
import { canonicalFilters } from '../filters.js';
import type { Breakdown, BreakdownDim, DimCounts } from './activity-day.js';

export const BACKFILL_DAYS = 366;
/** Per statement; the backfill reads up to a year of an Application's rows. */
const BACKFILL_STATEMENT_MS = 120_000;

function backfillTimeout(): RekeyError {
  return new RekeyError({
    statusCode: 503,
    code: 'ANALYTICS_TIMEOUT',
    message: 'A backfill statement for this Application exceeded its budget.',
    fix: 'Re-run the backfill: days already written are skipped. If it keeps failing, run it off-peak or report the Application id.',
  });
}

const DAY = Prisma.raw(`to_char(eu."created_at", 'YYYY-MM-DD')`);

interface DayAccumulator {
  newUsers: number;
  newVerified: number;
  signIns: number;
  onboardingCompleted: number;
  onboardingSkipped: number;
  breakdown: Breakdown;
  usageByMeter: Record<string, number>;
}

function emptyDay(): DayAccumulator {
  return {
    newUsers: 0,
    newVerified: 0,
    signIns: 0,
    onboardingCompleted: 0,
    onboardingSkipped: 0,
    breakdown: { platform: {}, country: {}, via: {}, createdVia: {} },
    usageByMeter: {},
  };
}

function add(acc: DayAccumulator, dim: BreakdownDim, key: string | null, field: keyof DimCounts, n: number): void {
  if (n === 0) return;
  const cell = (acc.breakdown[dim][key ?? 'unknown'] ??= {});
  cell[field] = (cell[field] ?? 0) + n;
}

/**
 * Backfill one Application. Returns the days written.
 *
 * @example
 *   const days = await backfillApplication(applicationId);
 */
export async function backfillApplication(
  applicationId: string,
  options: { now?: Date; days?: number; statementTimeoutMs?: number } = {},
): Promise<string[]> {
  const now = options.now ?? new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const last = addDays(todayUtc, -2);
  const first = addDays(todayUtc, -(options.days ?? BACKFILL_DAYS));
  const existing = new Set(
    (
      await prisma.applicationActivityDay.findMany({
        where: { applicationId, day: { gte: new Date(`${first}T00:00:00Z`), lte: new Date(`${last}T00:00:00Z`) } },
        select: { day: true },
      })
    ).map((r) => r.day.toISOString().slice(0, 10)),
  );
  const days = eachDay(first, last).filter((d) => !existing.has(d));
  if (days.length === 0) return [];

  const app = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    select: { activityTrackedSince: true, createdAt: true },
  });
  const tracked = app.activityTrackedSince.toISOString().slice(0, 10);
  const trackedSince = tracked === app.createdAt.toISOString().slice(0, 10) ? null : tracked;

  const acc = new Map(days.map((d) => [d, emptyDay()]));
  const start = new Date(`${first}T00:00:00Z`);
  const end = new Date(`${addDays(last, 1)}T00:00:00Z`);

  const activity = await withReadOnlyBudget(
    async (db) => {
      const created = await db.$queryRaw<
        Array<{ day: string; gp: number; gc: number; gcv: number; platform: string | null; country: string | null; cv: string | null; n: bigint; verified: bigint }>
      >(Prisma.sql`
        SELECT to_char(eu."created_at", 'YYYY-MM-DD') AS day,
               GROUPING(eu."last_platform")::int AS gp, GROUPING(eu."last_country")::int AS gc,
               GROUPING(eu."created_via")::int AS gcv,
               eu."last_platform" AS platform, eu."last_country"::text AS country, eu."created_via" AS cv,
               count(*) AS n, count(*) FILTER (WHERE eu."email_verified") AS verified
          FROM "end_users" AS eu
         WHERE eu."application_id" = ${applicationId} AND eu."created_at" >= ${start} AND eu."created_at" < ${end}
         GROUP BY GROUPING SETS ((${DAY}), (${DAY}, eu."last_platform"), (${DAY}, eu."last_country"), (${DAY}, eu."created_via"))`);
      for (const g of created) {
        const a = acc.get(g.day);
        if (!a) continue;
        const n = Number(g.n);
        if (g.gp && g.gc && g.gcv) {
          a.newUsers = n;
          a.newVerified = Number(g.verified);
        } else if (!g.gp) add(a, 'platform', g.platform, 'newUsers', n);
        else if (!g.gc) add(a, 'country', g.country, 'newUsers', n);
        else add(a, 'createdVia', g.cv, 'newUsers', n);
      }

      const signIns = await db.$queryRaw<Array<{ day: string; via: string | null; n: bigint }>>(Prisma.sql`
        SELECT to_char(se."created_at", 'YYYY-MM-DD') AS day, se."metadata"->>'via' AS via, count(*) AS n
          FROM "security_events" AS se
         WHERE se."application_id" = ${applicationId} AND se."type" = 'user.signed_in'
           AND se."created_at" >= ${start} AND se."created_at" < ${end}
         GROUP BY 1, 2`);
      for (const g of signIns) {
        const a = acc.get(g.day);
        if (!a) continue;
        a.signIns += Number(g.n);
        add(a, 'via', g.via, 'signIns', Number(g.n));
      }

      const onboarding = await db.$queryRaw<Array<{ day: string; kind: string; n: bigint }>>(Prisma.sql`
        SELECT to_char(eu."onboarding_completed_at", 'YYYY-MM-DD') AS day, 'completed' AS kind, count(*) AS n
          FROM "end_users" AS eu
         WHERE eu."application_id" = ${applicationId}
           AND eu."onboarding_completed_at" >= ${start} AND eu."onboarding_completed_at" < ${end}
         GROUP BY 1
        UNION ALL
        SELECT to_char(eu."onboarding_skipped_at", 'YYYY-MM-DD'), 'skipped', count(*)
          FROM "end_users" AS eu
         WHERE eu."application_id" = ${applicationId}
           AND eu."onboarding_skipped_at" >= ${start} AND eu."onboarding_skipped_at" < ${end}
         GROUP BY 1`);
      for (const g of onboarding) {
        const a = acc.get(g.day);
        if (!a) continue;
        if (g.kind === 'completed') a.onboardingCompleted = Number(g.n);
        else a.onboardingSkipped = Number(g.n);
      }

      const usage = await db.$queryRaw<Array<{ day: string; meter: string; n: bigint }>>(Prisma.sql`
        SELECT to_char(ur."occurred_at", 'YYYY-MM-DD') AS day, ur."meter_id" AS meter, sum(ur."quantity") AS n
          FROM "usage_meters" AS um
          JOIN "usage_records" AS ur ON ur."meter_id" = um."id"
         WHERE um."application_id" = ${applicationId} AND ur."occurred_at" >= ${start} AND ur."occurred_at" < ${end}
         GROUP BY 1, 2`);
      for (const g of usage) {
        const a = acc.get(g.day);
        if (a) a.usageByMeter[g.meter] = Number(g.n);
      }

      const activity = await liveActivityCounts(db, {
          applicationId,
          filters: canonicalFilters({}),
          todayUtc,
          trackedSince,
          days,
          metrics: ['dau', 'wau', 'mau'],
        });
      return activity;
    },
    { statementTimeoutMs: options.statementTimeoutMs ?? BACKFILL_STATEMENT_MS, onTimeout: backfillTimeout },
  );

  const rows = days.map((day) => {
    const a = acc.get(day)!;
    return {
      applicationId,
      day: new Date(`${day}T00:00:00Z`),
      timezone: 'UTC',
      dau: activity.dau.get(day) ?? null,
      wau: activity.wau.get(day) ?? null,
      mau: activity.mau.get(day) ?? null,
      newUsers: a.newUsers,
      newVerified: a.newVerified,
      signIns: a.signIns,
      onboardingCompleted: a.onboardingCompleted,
      onboardingSkipped: a.onboardingSkipped,
      breakdown: a.breakdown as unknown as Prisma.InputJsonValue,
      usageByMeter: a.usageByMeter as Prisma.InputJsonValue,
      source: 'backfill',
      final: true,
      computedAt: now,
    };
  });
  await prisma.applicationActivityDay.createMany({ data: rows, skipDuplicates: true });
  return days;
}

/**
 * Backfill every Application with users, one after another.
 *
 * @example
 *   await backfillAll({ log: console.log });
 */
export async function backfillAll(
  options: { now?: Date; days?: number; statementTimeoutMs?: number; log?: (line: string) => void } = {},
): Promise<{ applications: number; days: number; failed: number }> {
  const apps = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT a."id" FROM "applications" AS a
     WHERE EXISTS (SELECT 1 FROM "end_users" AS eu WHERE eu."application_id" = a."id")
     ORDER BY a."id"`;
  let total = 0;
  let failed = 0;
  for (const { id } of apps) {
    try {
      const written = await backfillApplication(id, options);
      total += written.length;
      options.log?.(`${id}: ${written.length} days written`);
    } catch (err) {
      failed += 1;
      const reason = err instanceof RekeyError ? `${err.code}: ${err.message}` : (err as Error).message;
      options.log?.(`${id}: failed, skipped (${reason})`);
    }
  }
  return { applications: apps.length, days: total, failed };
}
