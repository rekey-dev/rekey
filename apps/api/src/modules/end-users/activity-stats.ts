import { Prisma } from '@prisma/client';

const SERIES_DAYS = 30;

export interface ApplicationActivity {
  /** Distinct end users active today, the last 7 and the last 30 UTC days (today included). */
  activeUsers: { d1: number; d7: number; d30: number };
  /** Active end users per UTC day for the last 30 days, oldest first, gap-filled. */
  activitySeries: Array<{ date: string; count: number }>;
}

/**
 * A scalar subquery answering DAU/WAU/MAU and the 30-day active series for
 * one Application as a JSON object, for the stats statement to select beside
 * its other tiles. Derived from each user's `lastActiveOn` and
 * `activityBits`: a user was active on day D when `lastActiveOn >= D` and bit
 * `lastActiveOn - D` is set. Only users active in the last 30 days can set a
 * bit inside the window, so one range scan on `(application_id,
 * last_active_on)` covers it. No rollup table.
 *
 * @example
 *   prisma.$queryRaw(Prisma.sql`SELECT ${activityStatsSql(id)} AS activity`)
 */
export function activityStatsSql(applicationId: string): Prisma.Sql {
  return Prisma.sql`(
    WITH t AS (SELECT (now() AT TIME ZONE 'UTC')::date AS today),
    recent AS (
      SELECT eu."last_active_on" AS last_on, eu."activity_bits"::bigint AS bits
        FROM "end_users" AS eu, t
       WHERE eu."application_id" = ${applicationId}
         AND eu."last_active_on" >= t.today - ${SERIES_DAYS - 1}::int
         AND eu."activity_bits" IS NOT NULL
    ),
    series AS (
      SELECT k,
             count(r.last_on) FILTER (
               WHERE r.last_on >= t.today - k
                 AND (r.bits >> (r.last_on - (t.today - k))) & 1 = 1
             ) AS active
        FROM generate_series(0, ${SERIES_DAYS - 1}::int) AS k
        CROSS JOIN t
        LEFT JOIN recent AS r ON true
       GROUP BY k
    )
    SELECT json_build_object(
      'd1', (SELECT count(*) FROM recent, t WHERE recent.last_on >= t.today),
      'd7', (SELECT count(*) FROM recent, t WHERE recent.last_on >= t.today - 6),
      'd30', (SELECT count(*) FROM recent),
      'series', (SELECT json_agg(json_build_object('date', to_char(t.today - s.k, 'YYYY-MM-DD'), 'count', s.active)
                                 ORDER BY s.k DESC)
                   FROM series AS s, t)
    )
  )`;
}

interface ActivityJson {
  d1: number;
  d7: number;
  d30: number;
  series: Array<{ date: string; count: number }> | null;
}

/**
 * The stats response fields from the JSON `activityStatsSql` selected.
 *
 * @example
 *   const { activeUsers, activitySeries } = parseActivityStats(row.activity);
 */
export function parseActivityStats(value: unknown): ApplicationActivity {
  const json = value as ActivityJson;
  return {
    activeUsers: { d1: Number(json.d1), d7: Number(json.d7), d30: Number(json.d30) },
    activitySeries: (json.series ?? []).map((p) => ({ date: p.date, count: Number(p.count) })),
  };
}
