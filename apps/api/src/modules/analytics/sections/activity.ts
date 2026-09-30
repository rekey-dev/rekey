/**
 * A1 active users over time, A2 sign-ins by method, A3 accounts created.
 * The live path: UTC days, one segment.
 */

import { Prisma } from '@prisma/client';
import type { AnalyticsActivity, AnalyticsActivityPoint, AnalyticsSignInsPoint } from '@rekey.dev/shared-types';
import { userFilterSql } from '../filters.js';
import { liveActivityCounts } from '../live-activity.js';
import { addDays, daysBetween, eachDay } from '../range.js';
import type { SectionContext, SectionResult, SectionSpec } from '../envelope.js';
import { dayStart } from './kpis.js';
import { computeActivityFromRollup } from './activity-rollup.js';

/** Sign-ins by method are read live from the event log for at most this many days. */
export const LIVE_SIGN_IN_DAYS = 7;

export async function accountsCreatedByDay(
  db: Prisma.TransactionClient,
  ctx: SectionContext,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<Array<{ day: string; n: bigint }>>(Prisma.sql`
    SELECT to_char(eu."created_at", 'YYYY-MM-DD') AS day, count(*) AS n
      FROM "end_users" AS eu
     WHERE eu."application_id" = ${ctx.applicationId}
       AND eu."created_at" >= ${dayStart(from)}
       AND eu."created_at" < ${dayStart(addDays(to, 1))}
       ${userFilterSql(ctx.filters)}
     GROUP BY 1
  `);
  return new Map(rows.map((r) => [r.day, Number(r.n)]));
}

async function accountsBefore(db: Prisma.TransactionClient, ctx: SectionContext): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(*) AS n FROM "end_users" AS eu
     WHERE eu."application_id" = ${ctx.applicationId}
       AND eu."created_at" < ${dayStart(ctx.range.from)}
       ${userFilterSql(ctx.filters)}
  `);
  return Number(row?.n ?? 0);
}

/**
 * Sign-ins per day and method from `security_events`, for the last
 * LIVE_SIGN_IN_DAYS days of the range. Only the `via` filter applies, and it
 * means the method of each sign-in, not the user's latest.
 */
export async function liveSignIns(
  db: Prisma.TransactionClient,
  ctx: SectionContext,
): Promise<{ from: string; to: string; points: AnalyticsSignInsPoint[] }> {
  const to = ctx.range.to;
  const span = Math.min(LIVE_SIGN_IN_DAYS, ctx.range.days);
  const from = addDays(to, -(span - 1));
  const via = ctx.filters.via;
  const rows = await db.$queryRaw<Array<{ day: string; via: string | null; n: bigint }>>(Prisma.sql`
    SELECT to_char(se."created_at", 'YYYY-MM-DD') AS day, se."metadata"->>'via' AS via, count(*) AS n
      FROM "security_events" AS se
     WHERE se."application_id" = ${ctx.applicationId}
       AND se."type" = 'user.signed_in'
       AND se."created_at" >= ${dayStart(from)}
       AND se."created_at" < ${dayStart(addDays(to, 1))}
       ${via.length ? Prisma.sql`AND se."metadata"->>'via' = ANY(${via}::text[])` : Prisma.empty}
     GROUP BY 1, 2
  `);
  const byDay = new Map<string, AnalyticsSignInsPoint>(
    eachDay(from, to).map((d) => [d, { date: d, total: 0, byVia: {} }]),
  );
  for (const r of rows) {
    const point = byDay.get(r.day);
    if (!point) continue;
    const key = r.via ?? 'unknown';
    point.byVia[key] = (point.byVia[key] ?? 0) + Number(r.n);
    point.total += Number(r.n);
  }
  return { from, to, points: [...byDay.values()] };
}

async function computeActivity(
  db: Prisma.TransactionClient,
  ctx: SectionContext,
): Promise<SectionResult<AnalyticsActivity>> {
  if (ctx.mode === 'rollup') return computeActivityFromRollup(db, ctx);
  const { range } = ctx;
  const days = eachDay(range.from, range.to);
  const previousDays = range.compare ? eachDay(range.compare.from, range.compare.to) : [];
  const counts = await liveActivityCounts(db, {
    applicationId: ctx.applicationId,
    filters: ctx.filters,
    todayUtc: ctx.todayUtc,
    trackedSince: ctx.trackedSince,
    days: [...new Set([...days, ...previousDays])],
    metrics: ['dau', 'wau', 'mau'],
  });
  const created = await accountsCreatedByDay(db, ctx, range.compare?.from ?? range.from, range.to);
  const before = await accountsBefore(db, ctx);
  const signIns = await liveSignIns(db, ctx);

  const pointFor = (day: string) => ({
    date: day,
    dau: counts.dau.get(day) ?? null,
    wau: counts.wau.get(day) ?? null,
    mau: counts.mau.get(day) ?? null,
    accountsCreated: created.get(day) ?? 0,
  });
  const points: AnalyticsActivityPoint[] = days.map((day) => {
    const prevDay = range.compare ? addDays(day, -range.days) : null;
    return { ...pointFor(day), previous: prevDay ? pointFor(prevDay) : null };
  });

  return {
    kind: 'ok',
    source: 'live',
    timezone: 'UTC',
    data: {
      segments: [{ timezone: 'UTC', from: range.from, to: range.to, points }],
      accountsBefore: before,
      signIns: {
        status: 'ok',
        timezone: 'UTC',
        ...signIns,
        partial: daysBetween(signIns.from, range.to) + 1 < range.days,
        ignoredFilters: ['platform', 'country', 'createdVia', 'onboarding', 'verified', 'mfa', 'plan', 'paying', 'org'].filter(
          (name) => {
            const v = ctx.filters[name as keyof typeof ctx.filters];
            return Array.isArray(v) ? v.length > 0 : v !== null;
          },
        ),
      },
    },
  };
}

export const activitySection: SectionSpec<AnalyticsActivity> = {
  name: 'activity',
  scope: 'overview:read',
  applies: 'all',
  freshSeconds: 60,
  compute: computeActivity,
};
