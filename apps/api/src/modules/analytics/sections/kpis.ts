/**
 * K1-K6: total and new users, DAU, WAU, MAU, stickiness, paying users and
 * conversion, each with its value for the comparison period.
 */

import { Prisma } from '@prisma/client';
import type { AnalyticsKpis, AnalyticsMetric, AnalyticsMetricGap } from '@rekey.dev/shared-types';
import { PAYING_STATUSES, userFilterSql } from '../filters.js';
import { liveActivityCounts, type ActivityCounts } from '../live-activity.js';
import { LOCAL_GAP_FIX, metricGaps, rollupDayValues, type DayValue } from '../rollup/read.js';
import { dayWindow } from '../rollup/day-window.js';
import { addDays, eachDay } from '../range.js';
import type { SectionContext, SectionResult, SectionSpec } from '../envelope.js';

/** The start of a UTC day, as the naive UTC timestamp the columns hold. */
export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/**
 * @example
 *   metric(10, 8) // { value: 10, previous: 8, delta: 2 }
 */
export function metric(value: number | null, previous: number | null): AnalyticsMetric {
  return { value, previous, delta: value !== null && previous !== null ? value - previous : null };
}

export function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

function mean(values: Array<number | null>): number | null {
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return (values as number[]).reduce((a, b) => a + b, 0) / values.length;
}

interface PopulationRow {
  total_at_to: bigint;
  total_before_from: bigint;
  erased_at_to: bigint;
  new_in_range: bigint;
  new_in_compare: bigint | null;
}

/**
 * One pass over the Application's users (the `(application_id, created_at)`
 * index) for every population count the KPI row needs. Erased tombstones are
 * counted, by decision; `erased` says how many.
 */
/** The start of `day` in the zone the section counts in: UTC on the live path. */
export function boundary(ctx: SectionContext, day: string): Date {
  return ctx.mode === 'rollup' ? dayWindow(day, ctx.range.timezone).start : dayStart(day);
}

export async function populationCounts(db: Prisma.TransactionClient, ctx: SectionContext): Promise<PopulationRow> {
  const toEnd = boundary(ctx, addDays(ctx.range.to, 1));
  const fromStart = boundary(ctx, ctx.range.from);
  const compareStart = ctx.range.compare ? boundary(ctx, ctx.range.compare.from) : null;
  const [row] = await db.$queryRaw<PopulationRow[]>(Prisma.sql`
    SELECT count(*) FILTER (WHERE eu."created_at" < ${toEnd}) AS total_at_to,
           count(*) FILTER (WHERE eu."created_at" < ${fromStart}) AS total_before_from,
           count(*) FILTER (WHERE eu."created_at" < ${toEnd} AND eu."erased_at" IS NOT NULL) AS erased_at_to,
           count(*) FILTER (WHERE eu."created_at" >= ${fromStart} AND eu."created_at" < ${toEnd}) AS new_in_range,
           CASE WHEN ${compareStart}::timestamp IS NULL THEN NULL
                ELSE count(*) FILTER (WHERE eu."created_at" >= ${compareStart} AND eu."created_at" < ${fromStart}) END
             AS new_in_compare
      FROM "end_users" AS eu
     WHERE eu."application_id" = ${ctx.applicationId}
       AND eu."created_at" < ${toEnd}
       ${userFilterSql(ctx.filters)}
  `);
  return row!;
}

function countsOf(values: ReadonlyMap<string, DayValue>): ActivityCounts {
  const out: ActivityCounts = { dau: new Map(), wau: new Map(), mau: new Map() };
  for (const [day, v] of values) {
    out.dau.set(day, v.dau);
    out.wau.set(day, v.wau);
    out.mau.set(day, v.mau);
  }
  return out;
}

/** The KPI names each day-level gap nulls: DAU feeds the average and stickiness, MAU feeds stickiness. */
const KPIS_OF: Record<string, string[]> = { dau: ['dau', 'dauAverage', 'stickiness'], wau: ['wau'], mau: ['mau', 'stickiness'] };

function kpiGaps(values: ReadonlyMap<string, DayValue>, dauDays: string[], edgeDays: string[]): AnalyticsMetricGap[] {
  const gaps = [...metricGaps(values, dauDays, ['dau']), ...metricGaps(values, edgeDays, ['wau', 'mau'])];
  const merged = new Map<string, AnalyticsMetricGap>();
  for (const g of gaps) {
    const into = merged.get(g.reason);
    const metrics = g.metrics.flatMap((m) => KPIS_OF[m] ?? [m]);
    if (!into) merged.set(g.reason, { ...g, metrics: [...new Set(metrics)] });
    else {
      into.metrics = [...new Set([...into.metrics, ...metrics])];
      into.days = [...new Set([...into.days, ...g.days])].sort();
      if (into.fix !== g.fix) into.fix = LOCAL_GAP_FIX[g.reason];
    }
  }
  return [...merged.values()];
}

async function payingUsers(db: Prisma.TransactionClient, ctx: SectionContext): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(DISTINCT s."end_user_id") AS n
      FROM "subscriptions" AS s
      JOIN "end_users" AS eu ON eu."id" = s."end_user_id"
     WHERE s."application_id" = ${ctx.applicationId}
       AND s."status"::text = ANY(${[...PAYING_STATUSES]}::text[])
       ${userFilterSql(ctx.filters)}
  `);
  return Number(row?.n ?? 0);
}

async function computeKpis(db: Prisma.TransactionClient, ctx: SectionContext): Promise<SectionResult<AnalyticsKpis>> {
  const { range } = ctx;
  const rangeDays = eachDay(range.from, range.to);
  const compareDays = range.compare ? eachDay(range.compare.from, range.compare.to) : [];
  const edgeDays = range.compare ? [range.to, range.compare.to] : [range.to];

  const population = await populationCounts(db, ctx);
  const dauDays = [...new Set([...rangeDays, ...compareDays])];
  const rolled = ctx.mode === 'rollup' ? await rollupDayValues(db, ctx, dauDays) : null;
  const counts = rolled
    ? countsOf(rolled)
    : await liveActivityCounts(db, {
        applicationId: ctx.applicationId,
        filters: ctx.filters,
        todayUtc: ctx.todayUtc,
        trackedSince: ctx.trackedSince,
        days: dauDays,
        metrics: ['dau'],
        spanDays: edgeDays,
      });
  const spans = counts;
  const paying = await payingUsers(db, ctx);

  const at = (m: Map<string, number | null>, day: string | undefined): number | null =>
    day === undefined ? null : (m.get(day) ?? null);
  const prevTo = range.compare?.to;
  const dauAvg = mean(rangeDays.map((d) => at(counts.dau, d)));
  const dauAvgPrev = range.compare ? mean(compareDays.map((d) => at(counts.dau, d))) : null;
  const mau = at(spans.mau, range.to);
  const mauPrev = at(spans.mau, prevTo);
  const total = Number(population.total_at_to);
  const totalPrev = range.compare ? Number(population.total_before_from) : null;

  return {
    kind: 'ok',
    source: ctx.mode,
    timezone: ctx.mode === 'rollup' ? range.timezone : 'UTC',
    gaps: rolled ? kpiGaps(rolled, dauDays, edgeDays) : [],
    data: {
      totalUsers: { ...metric(total, totalPrev), erased: Number(population.erased_at_to) },
      newUsers: metric(
        Number(population.new_in_range),
        population.new_in_compare === null ? null : Number(population.new_in_compare),
      ),
      dau: metric(at(counts.dau, range.to), at(counts.dau, prevTo)),
      dauAverage: metric(dauAvg, dauAvgPrev),
      wau: metric(at(spans.wau, range.to), at(spans.wau, prevTo)),
      mau: metric(mau, mauPrev),
      stickiness: metric(ratio(dauAvg, mau), ratio(dauAvgPrev, mauPrev)),
      payingUsers: metric(paying, null),
      conversion: metric(ratio(paying, total), null),
    },
  };
}

export const kpisSection: SectionSpec<AnalyticsKpis> = {
  name: 'kpis',
  scope: 'overview:read',
  applies: 'all',
  freshSeconds: 60,
  compute: computeKpis,
};
