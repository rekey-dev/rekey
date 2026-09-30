/**
 * DAU, WAU and MAU per UTC day, live from the activity bits.
 *
 * Each user's bits are first aligned to today: `(activity_bits << (today -
 * last_active_on))::bigint` puts "active on today - p" at bit p for every
 * user. After that, one pass sums bit p across users for each day wanted, so
 * the cost is one index range scan on `(application_id, last_active_on)` plus
 * a fixed number of bit operations per user, with no row per user-day.
 *
 * WAU on day D is "any of D-6..D", the OR of the aligned bits shifted by 0..6;
 * MAU the OR over 0..29, built by doubling. The bits hold 63 days, so DAU is
 * exact for the last 63 days, WAU for the last 57 and MAU for the last 34.
 * Anything older is null, never a guess.
 *
 * `spans` is MATERIALIZED on purpose: inlined, Postgres copies the WAU and
 * MAU expression trees into every aggregate that reads them, which doubled
 * the cost on a 500k-user Application.
 */

import { Prisma } from '@prisma/client';
import type { AnalyticsFilters } from '@rekey.dev/shared-types';
import { userFilterSql } from './filters.js';
import { addDays, daysBetween } from './range.js';

export const BIT_WINDOW = 63;
export const WAU_SPAN = 7;
export const MAU_SPAN = 30;

export type ActivityMetric = 'dau' | 'wau' | 'mau';

const SPAN: Record<ActivityMetric, number> = { dau: 1, wau: WAU_SPAN, mau: MAU_SPAN };

/**
 * The oldest UTC day each metric is exact for, given today and the day the
 * Application started tracking (null when tracking began with the app, so
 * earlier days are genuinely empty).
 */
export function exactFrom(metric: ActivityMetric, todayUtc: string, trackedSince: string | null): string {
  const windowStart = addDays(todayUtc, -(BIT_WINDOW - SPAN[metric]));
  if (!trackedSince) return windowStart;
  const trackedStart = addDays(trackedSince, SPAN[metric] - 1);
  return trackedStart > windowStart ? trackedStart : windowStart;
}

export type ActivityCounts = Record<ActivityMetric, Map<string, number | null>>;

interface Wanted {
  day: string;
  metric: ActivityMetric;
  position: number;
}

/**
 * Counts for each (day, metric) asked for. Days outside what the bits can
 * answer come back null without touching the database.
 *
 * @example
 *   const counts = await liveActivityCounts(tx, { applicationId, filters, todayUtc: '2026-09-30', trackedSince: null, days: ['2026-09-29'], metrics: ['dau', 'mau'] });
 */
export async function liveActivityCounts(
  db: Prisma.TransactionClient,
  args: {
    applicationId: string;
    filters: AnalyticsFilters;
    todayUtc: string;
    trackedSince: string | null;
    days: readonly string[];
    metrics: readonly ActivityMetric[];
    /** Days to also count WAU and MAU for, in the same scan. */
    spanDays?: readonly string[];
  },
): Promise<ActivityCounts> {
  const out: ActivityCounts = { dau: new Map(), wau: new Map(), mau: new Map() };
  const wanted: Wanted[] = [];
  const plan: Array<[ActivityMetric, readonly string[]]> = args.metrics.map((m) => [m, args.days]);
  if (args.spanDays) plan.push(['wau', args.spanDays], ['mau', args.spanDays]);
  for (const [metric, days] of plan) {
    const from = exactFrom(metric, args.todayUtc, args.trackedSince);
    for (const day of days) {
      if (out[metric].has(day)) continue;
      if (day < from || day > args.todayUtc) {
        out[metric].set(day, null);
        continue;
      }
      wanted.push({ day, metric, position: daysBetween(day, args.todayUtc) });
    }
  }
  if (wanted.length === 0) return out;

  const oldest = wanted.reduce((m, w) => (w.day < m ? w.day : m), args.todayUtc);
  const earliestScan = addDays(args.todayUtc, -(BIT_WINDOW - 1));
  const scanFrom = addDays(oldest, -(MAU_SPAN - 1)) > earliestScan ? addDays(oldest, -(MAU_SPAN - 1)) : earliestScan;

  const aggregates = packedAggregates(wanted);
  const selects = aggregates.map((agg, i) => Prisma.raw(`${agg.sql} AS c${i}`));

  const rows = await db.$queryRaw<Array<Record<string, number | bigint>>>(Prisma.sql`
    WITH aligned AS (
      SELECT ((eu."activity_bits" << (${args.todayUtc}::date - eu."last_active_on"))::bigint) AS a
        FROM "end_users" AS eu
       WHERE eu."application_id" = ${args.applicationId}
         AND eu."last_active_on" >= ${scanFrom}::date
         AND eu."last_active_on" <= ${args.todayUtc}::date
         AND eu."activity_bits" IS NOT NULL
         ${userFilterSql(args.filters)}
    ),
    s2 AS (SELECT a, a | (a >> 1) AS s2 FROM aligned),
    s4 AS (SELECT a, s2, s2 | (s2 >> 2) AS s4 FROM s2),
    s8 AS (SELECT a, s2, s4, s4 | (s4 >> 4) AS s8 FROM s4),
    spans AS MATERIALIZED (
      SELECT a,
             s4 | (s2 >> 4) | (a >> 6) AS w7,
             (s8 | (s8 >> 8)) | (s8 >> 16) | (s4 >> 24) | (s2 >> 28) AS m30
        FROM s8
    )
    SELECT ${Prisma.join(selects, ', ')} FROM spans
  `);
  const row = rows[0] ?? {};
  aggregates.forEach((agg, i) => {
    const total = BigInt(String(row[`c${i}`] ?? 0));
    out[agg.low.metric].set(agg.low.day, Number(total & LANE_MASK));
    if (agg.high) out[agg.high.metric].set(agg.high.day, Number(total >> 32n));
  });
  return out;
}

const COLUMN: Record<ActivityMetric, string> = { dau: 'a', wau: 'w7', mau: 'm30' };
const LANE_MASK = 0xffffffffn;

/**
 * One aggregate per wanted (day, metric), except that positions p and p + 32
 * of the same column share one: `(x >> p) & (1 | 1 << 32)` puts bit p in the
 * low 32-bit lane and bit p + 32 in the high one, so a single sum counts
 * both. The lanes cannot carry into each other below 2^32 users. Measured on
 * 190k active users: 30 packed sums take 0.6 s where 60 plain ones take 1.4 s.
 */
function packedAggregates(wanted: Wanted[]): Array<{ sql: string; low: Wanted; high: Wanted | null }> {
  const out: Array<{ sql: string; low: Wanted; high: Wanted | null }> = [];
  const byKey = new Map(wanted.map((w) => [`${w.metric}:${w.position}`, w]));
  const used = new Set<Wanted>();
  for (const w of wanted) {
    if (used.has(w)) continue;
    used.add(w);
    const partner = w.position < 32 ? byKey.get(`${w.metric}:${w.position + 32}`) : undefined;
    if (partner && !used.has(partner)) {
      used.add(partner);
      out.push({ sql: `COALESCE(sum((${COLUMN[w.metric]} >> ${w.position}) & 4294967297), 0)`, low: w, high: partner });
    } else {
      out.push({ sql: `COALESCE(sum(((${COLUMN[w.metric]} >> ${w.position}) & 1)::int), 0)`, low: w, high: null });
    }
  }
  return out;
}
