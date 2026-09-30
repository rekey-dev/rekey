/**
 * The activity section from the daily rollup: days in the reporting
 * timezone, split into one segment per zone so a series never joins days
 * counted in two zones.
 */

import { Prisma } from '@prisma/client';
import type { AnalyticsActivity, AnalyticsActivityPoint, AnalyticsActivitySegment } from '@rekey.dev/shared-types';
import { userFilterSql } from '../filters.js';
import { addDays, eachDay } from '../range.js';
import type { SectionContext, SectionResult } from '../envelope.js';
import { accountsCreatedByLocalDay, metricGaps, rollupDayValues, type DayValue } from '../rollup/read.js';
import { boundary } from './kpis.js';

/** Consecutive points of one zone per segment. */
export function segmentsByZone(points: Array<AnalyticsActivityPoint & { timezone: string }>): AnalyticsActivitySegment[] {
  const out: AnalyticsActivitySegment[] = [];
  for (const { timezone, ...point } of points) {
    const last = out.at(-1);
    if (last && last.timezone === timezone) {
      last.points.push(point);
      last.to = point.date;
    } else {
      out.push({ timezone, from: point.date, to: point.date, points: [point] });
    }
  }
  return out;
}

export async function computeActivityFromRollup(
  db: Prisma.TransactionClient,
  ctx: SectionContext,
): Promise<SectionResult<AnalyticsActivity>> {
  const { range } = ctx;
  const days = eachDay(range.from, range.to);
  const previousDays = range.compare ? eachDay(range.compare.from, range.compare.to) : [];
  const values = await rollupDayValues(db, ctx, [...days, ...previousDays]);
  const created = await accountsCreatedByLocalDay(db, ctx, range.compare?.from ?? range.from, range.to);
  const [before] = await db.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(*) AS n FROM "end_users" AS eu
     WHERE eu."application_id" = ${ctx.applicationId} AND eu."created_at" < ${boundary(ctx, range.from)}
       ${userFilterSql(ctx.filters)}`);

  const pointFor = (day: string) => {
    const v: DayValue | undefined = values.get(day);
    return { date: day, dau: v?.dau ?? null, wau: v?.wau ?? null, mau: v?.mau ?? null, accountsCreated: created.get(day) ?? 0 };
  };
  const points = days.map((day) => {
    const prevDay = range.compare ? addDays(day, -range.days) : null;
    return {
      ...pointFor(day),
      previous: prevDay ? pointFor(prevDay) : null,
      timezone: values.get(day)?.timezone ?? range.timezone,
    };
  });

  const signInPoints = days.map((day) => {
    const v = values.get(day);
    return { date: day, total: v?.signIns ?? 0, byVia: v?.signInsByVia ?? {} };
  });
  const partial = days.some((d) => values.get(d)?.signIns == null);
  const zones = new Set(days.map((d) => values.get(d)?.timezone ?? range.timezone));

  return {
    kind: 'ok',
    source: 'rollup',
    timezone: range.timezone,
    gaps: metricGaps(values, [...days, ...previousDays], ['dau', 'wau', 'mau']),
    data: {
      segments: segmentsByZone(points),
      accountsBefore: Number(before?.n ?? 0),
      signIns: {
        status: 'ok',
        timezone: zones.size === 1 ? [...zones][0]! : range.timezone,
        from: range.from,
        to: range.to,
        points: signInPoints,
        partial,
        ignoredFilters: [],
      },
    },
  };
}
