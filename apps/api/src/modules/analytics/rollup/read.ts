/**
 * The rollup read path: per-day values from `application_activity_days`,
 * each labelled with the zone it was counted in, with the live bits filling
 * a missing day only when both are UTC.
 */

import { Prisma } from '@prisma/client';
import type { AnalyticsFilters, AnalyticsMetricGap } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { liveActivityCounts } from '../live-activity.js';
import { userFilterSql } from '../filters.js';
import type { SectionContext } from '../envelope.js';
import type { Breakdown } from './activity-day.js';
import { dayWindow } from './day-window.js';

export type SpanMetric = 'dau' | 'wau' | 'mau';

export interface DayValue {
  timezone: string;
  dau: number | null;
  wau: number | null;
  mau: number | null;
  /** Set when the day has a rollup row but some metrics are still null, and why. */
  gap: { reason: AnalyticsMetricGap['reason']; metrics: SpanMetric[]; utcRow: boolean } | null;
  /** Null when no rollup row holds the day. */
  signIns: number | null;
  signInsByVia: Record<string, number> | null;
  usageByMeter: Record<string, number> | null;
}

type Dim = 'platform' | 'country' | 'via' | 'createdVia';

// The live bits count UTC days, so narrowing the range only helps where every
// gap day is a UTC row; on a local-zone row it would answer nothing.
const UTC_GAP_FIX: Record<AnalyticsMetricGap['reason'], string> = {
  filter_not_in_rollup:
    'Remove the platform, country or via filter, or narrow the range to the last 30 days, which the live activity bits answer.',
  not_in_rollup: 'Narrow the range to the last 30 days, which the live activity bits answer.',
};

/** The fix when any gap day was counted in a local zone. */
export const LOCAL_GAP_FIX: Record<AnalyticsMetricGap['reason'], string> = {
  filter_not_in_rollup: 'Remove the platform, country or via filter.',
  not_in_rollup: 'Pick a range that starts after these days; the rollup holds no activity for them.',
};

/**
 * The gaps among `days` for `metrics`, one entry per reason.
 *
 * @example
 *   metricGaps(values, days, ['wau', 'mau']) // [{ reason: 'filter_not_in_rollup', metrics: ['wau', 'mau'], days: [...], fix }]
 */
export function metricGaps(
  values: ReadonlyMap<string, DayValue>,
  days: readonly string[],
  metrics: readonly SpanMetric[],
): AnalyticsMetricGap[] {
  const byReason = new Map<AnalyticsMetricGap['reason'], { metrics: Set<string>; days: Set<string>; local: boolean }>();
  for (const day of days) {
    const gap = values.get(day)?.gap;
    const hit = gap?.metrics.filter((m) => metrics.includes(m)) ?? [];
    if (!gap || hit.length === 0) continue;
    const entry = byReason.get(gap.reason) ?? byReason.set(gap.reason, { metrics: new Set(), days: new Set(), local: false }).get(gap.reason)!;
    entry.local ||= !gap.utcRow;
    for (const m of hit) entry.metrics.add(m);
    entry.days.add(day);
  }
  return [...byReason].map(([reason, e]) => ({
    reason,
    metrics: [...e.metrics],
    days: [...e.days].sort(),
    fix: (e.local ? LOCAL_GAP_FIX : UTC_GAP_FIX)[reason],
  }));
}

/** The one dimension filter a rollup request carries, if any. */
export function dimensionFilter(f: AnalyticsFilters): { dim: Dim; keys: string[] } | null {
  if (f.platform.length) return { dim: 'platform', keys: f.platform };
  if (f.country.length) return { dim: 'country', keys: f.country };
  if (f.via.length) return { dim: 'via', keys: f.via };
  return null;
}

function matches(dim: Dim, key: string, wanted: string[]): boolean {
  if (dim !== 'createdVia') return wanted.includes(key);
  return wanted.some((w) => w === key || (w === 'oauth' && (key === 'oauth' || key.startsWith('oauth:'))));
}

function sumDim(b: Breakdown, dim: Dim, wanted: string[], field: SpanMetric | 'signIns'): number | null {
  const cells = Object.entries(b[dim] ?? {}).filter(([k]) => matches(dim, k, wanted));
  if (dim === 'createdVia' && field !== 'signIns') return null;
  return cells.reduce((s, [, c]) => s + (c[field] ?? 0), 0);
}

/**
 * First day the rollup holds for the Application, or null.
 *
 * @example
 *   const from = await rollupFrom(applicationId);
 */
export async function rollupFrom(applicationId: string): Promise<string | null> {
  const first = await prisma.applicationActivityDay.findFirst({
    where: { applicationId },
    orderBy: { day: 'asc' },
    select: { day: true },
  });
  return first ? first.day.toISOString().slice(0, 10) : null;
}

/**
 * @example
 *   const values = await rollupDayValues(tx, ctx, days);
 */
export async function rollupDayValues(
  db: Prisma.TransactionClient,
  ctx: SectionContext,
  days: readonly string[],
): Promise<Map<string, DayValue>> {
  const out = new Map<string, DayValue>();
  if (days.length === 0) return out;
  const sorted = [...days].sort();
  const rows = await db.applicationActivityDay.findMany({
    where: {
      applicationId: ctx.applicationId,
      day: { gte: new Date(`${sorted[0]}T00:00:00Z`), lte: new Date(`${sorted.at(-1)}T00:00:00Z`) },
    },
  });
  const dim = dimensionFilter(ctx.filters);
  const byDay = new Map(rows.map((r) => [r.day.toISOString().slice(0, 10), r]));
  // UTC days the live bits can answer better than the row: a missing row, or
  // a dimension filter on a row without per-dimension spans (a backfilled
  // day). A row's null spans are never refilled: the bits' window only moves
  // away from a day, so what the backfill could not answer the live path
  // cannot either, and asking would scan every active user for nothing. A
  // non-UTC day is never refilled: the bits count UTC days.
  const liveUtc: string[] = [];
  for (const day of days) {
    const row = byDay.get(day);
    if (row?.timezone === 'UTC' && dim && !(row.breakdown as unknown as Breakdown).dimSpans) liveUtc.push(day);
    if (!row) {
      if (ctx.range.timezone === 'UTC') liveUtc.push(day);
      out.set(day, { timezone: ctx.range.timezone, dau: null, wau: null, mau: null, gap: null, signIns: null, signInsByVia: null, usageByMeter: null });
      continue;
    }
    const b = row.breakdown as unknown as Breakdown;
    const viaCells = Object.entries(b.via ?? {}).filter(([k]) => !dim || dim.dim !== 'via' || dim.keys.includes(k));
    const spans = dim && b.dimSpans ? dim : null;
    out.set(day, {
      timezone: row.timezone,
      dau: dim ? (row.source === 'backfill' ? null : sumDim(b, dim.dim, dim.keys, 'dau')) : row.dau,
      wau: dim ? (spans ? sumDim(b, spans.dim, spans.keys, 'wau') : null) : row.wau,
      mau: dim ? (spans ? sumDim(b, spans.dim, spans.keys, 'mau') : null) : row.mau,
      gap: null,
      signIns: dim && dim.dim === 'via' ? sumDim(b, 'via', dim.keys, 'signIns') : dim ? null : row.signIns,
      signInsByVia: dim && dim.dim !== 'via' ? null : Object.fromEntries(viaCells.filter(([, c]) => c.signIns).map(([k, c]) => [k, c.signIns!])),
      usageByMeter: (row.usageByMeter as Record<string, number>) ?? {},
    });
  }
  if (liveUtc.length > 0) {
    const live = await liveActivityCounts(db, {
      applicationId: ctx.applicationId,
      filters: ctx.filters,
      todayUtc: ctx.todayUtc,
      trackedSince: ctx.trackedSince,
      days: liveUtc,
      metrics: ['dau', 'wau', 'mau'],
    });
    for (const day of liveUtc) {
      const v = out.get(day)!;
      v.dau = live.dau.get(day) ?? v.dau;
      v.wau = live.wau.get(day) ?? v.wau;
      v.mau = live.mau.get(day) ?? v.mau;
    }
  }
  for (const day of days) {
    const v = out.get(day)!;
    if (!byDay.has(day)) continue;
    const missing = (['dau', 'wau', 'mau'] as const).filter((m) => v[m] === null);
    if (missing.length) v.gap = { reason: dim ? 'filter_not_in_rollup' : 'not_in_rollup', metrics: missing, utcRow: v.timezone === 'UTC' };
  }
  return out;
}

/**
 * Accounts created per local day of `timezone`, with every filter applied.
 * Exact in any zone: `created_at` is a full timestamp.
 */
export async function accountsCreatedByLocalDay(
  db: Prisma.TransactionClient,
  ctx: SectionContext,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const tz = ctx.range.timezone;
  const start = dayWindow(from, tz).start;
  const end = dayWindow(to, tz).end;
  const rows = await db.$queryRaw<Array<{ day: string; n: bigint }>>(Prisma.sql`
    SELECT to_char((eu."created_at" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, count(*) AS n
      FROM "end_users" AS eu
     WHERE eu."application_id" = ${ctx.applicationId} AND eu."created_at" >= ${start} AND eu."created_at" < ${end}
       ${userFilterSql(ctx.filters)}
     GROUP BY 1`);
  return new Map(rows.map((r) => [r.day, Number(r.n)]));
}

/**
 * Days of the range, from the first rollup day on, that have no rollup row.
 * They are filled from the live bits when both are UTC and the day is in the
 * bits' window, and are null otherwise.
 *
 * @example
 *   const missing = await rollupMissingDays(applicationId, '2026-09-01', '2026-09-30', '2026-08-15');
 */
export async function rollupMissingDays(applicationId: string, from: string, to: string, firstDay: string): Promise<string[]> {
  const start = from > firstDay ? from : firstDay;
  if (start > to) return [];
  const rows = await prisma.applicationActivityDay.findMany({
    where: { applicationId, day: { gte: new Date(`${start}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
    select: { day: true },
  });
  const have = new Set(rows.map((r) => r.day.toISOString().slice(0, 10)));
  const out: string[] = [];
  for (let d = start; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
    if (!have.has(d)) out.push(d);
  }
  return out;
}
