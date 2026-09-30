/**
 * One `ApplicationActivityDay` row: activity, sign-ups, sign-ins, onboarding
 * and usage for one calendar day in the Application's reporting timezone.
 *
 * DAU, WAU and MAU come from two sources, chosen by the zone:
 *
 *   - UTC: the activity bits, exactly as the live path counts them, so a
 *     rolled-up UTC day and a live one always agree.
 *   - any other zone: the bits are UTC days and cannot be re-cut, so the day
 *     counts users with a session issued or refreshed inside its local
 *     window. Every sign-in, every day's first refresh and every MCP token
 *     grant writes such a row, so MCP use counts as activity here as it does
 *     in the bits.
 */

import { Prisma } from '@prisma/client';
import { addDays, daysBetween } from '../range.js';
import { dayWindow } from './day-window.js';

export interface DimCounts {
  dau?: number;
  wau?: number;
  mau?: number;
  newUsers?: number;
  signIns?: number;
}

export type BreakdownDim = 'platform' | 'country' | 'via' | 'createdVia';

/**
 * Per-dimension counts for one day. `dimSpans` marks a row that also holds
 * WAU and MAU per platform, country and sign-in method; a row without it
 * (a backfilled day) has none, so a filtered WAU or MAU there is unknown,
 * not zero.
 */
export type Breakdown = Record<BreakdownDim, Record<string, DimCounts>> & { dimSpans?: true };

export interface ActivityDayData {
  dau: number | null;
  wau: number | null;
  mau: number | null;
  newUsers: number;
  newVerified: number;
  signIns: number;
  onboardingCompleted: number;
  onboardingSkipped: number;
  breakdown: Breakdown;
  usageByMeter: Record<string, number>;
}

interface GroupedActivity {
  gp: number;
  gc: number;
  gv: number;
  platform: string | null;
  country: string | null;
  via: string | null;
  dau: bigint | null;
  wau: bigint | null;
  mau: bigint | null;
}

const UNKNOWN = 'unknown';
const key = (v: string | null): string => v ?? UNKNOWN;

const GROUPING = Prisma.sql`
  GROUPING(platform)::int AS gp, GROUPING(country)::int AS gc, GROUPING(via)::int AS gv, platform, country, via`;
const SETS = Prisma.sql`GROUP BY GROUPING SETS ((), (platform), (country), (via))`;

/** Activity per day from the UTC bits. `day` must lie within the last 34 days. */
async function activityFromBits(
  db: Prisma.TransactionClient,
  applicationId: string,
  day: string,
  todayUtc: string,
): Promise<GroupedActivity[]> {
  const p = daysBetween(day, todayUtc);
  const pos = Prisma.raw(String(p));
  return db.$queryRaw<GroupedActivity[]>(Prisma.sql`
    WITH aligned AS (
      SELECT eu."last_platform" AS platform, eu."last_country"::text AS country, eu."last_sign_in_via" AS via,
             ((eu."activity_bits" << (${todayUtc}::date - eu."last_active_on"))::bigint) AS a
        FROM "end_users" AS eu
       WHERE eu."application_id" = ${applicationId}
         AND eu."last_active_on" >= ${addDays(day, -29)}::date
         AND eu."last_active_on" >= ${addDays(todayUtc, -62)}::date
         AND eu."last_active_on" <= ${todayUtc}::date
         AND eu."activity_bits" IS NOT NULL
    ),
    s2 AS (SELECT platform, country, via, a, a | (a >> 1) AS s2 FROM aligned),
    s4 AS (SELECT platform, country, via, a, s2, s2 | (s2 >> 2) AS s4 FROM s2),
    s8 AS (SELECT platform, country, via, a, s2, s4, s4 | (s4 >> 4) AS s8 FROM s4),
    spans AS MATERIALIZED (
      SELECT platform, country, via, a,
             s4 | (s2 >> 4) | (a >> 6) AS w7,
             (s8 | (s8 >> 8)) | (s8 >> 16) | (s4 >> 24) | (s2 >> 28) AS m30
        FROM s8
    )
    SELECT ${GROUPING},
           sum(((a >> ${pos}) & 1)::int) AS dau,
           sum(((w7 >> ${pos}) & 1)::int) AS wau,
           sum(((m30 >> ${pos}) & 1)::int) AS mau
      FROM spans ${SETS}`);
}

/**
 * Activity per local day from session rows issued or refreshed in the window:
 * one range scan on `refresh_tokens (application_id, created_at)` over the
 * 30 days, grouped per user, so the cost follows the sessions in the window
 * rather than a probe per user.
 */
async function activityFromSessions(
  db: Prisma.TransactionClient,
  applicationId: string,
  day: string,
  timezone: string,
): Promise<GroupedActivity[]> {
  const { start: d1, end } = dayWindow(day, timezone);
  const d7 = dayWindow(addDays(day, -6), timezone).start;
  const d30 = dayWindow(addDays(day, -29), timezone).start;
  return db.$queryRaw<GroupedActivity[]>(Prisma.sql`
    WITH per_user AS (
      SELECT rt."end_user_id",
             bool_or(rt."created_at" >= ${d1}) AS d,
             bool_or(rt."created_at" >= ${d7}) AS w
        FROM "refresh_tokens" AS rt
       WHERE rt."application_id" = ${applicationId}
         AND rt."created_at" >= ${d30} AND rt."created_at" < ${end}
       GROUP BY rt."end_user_id"
    ),
    act AS (
      SELECT eu."last_platform" AS platform, eu."last_country"::text AS country, eu."last_sign_in_via" AS via, p.d, p.w
        FROM per_user AS p
        JOIN "end_users" AS eu ON eu."id" = p."end_user_id"
    )
    SELECT ${GROUPING},
           count(*) FILTER (WHERE d) AS dau, count(*) FILTER (WHERE w) AS wau, count(*) AS mau
      FROM act ${SETS}`);
}

type Group = { key: string | null; n: bigint };

function emptyBreakdown(): Breakdown {
  return { platform: {}, country: {}, via: {}, createdVia: {}, dimSpans: true };
}

function add(b: Breakdown, dim: BreakdownDim, k: string, field: keyof DimCounts, n: number): void {
  if (n === 0) return;
  const cell = (b[dim][k] ??= {});
  cell[field] = (cell[field] ?? 0) + n;
}

/**
 * @example
 *   const data = await computeActivityDay(tx, { applicationId, day: '2026-09-30', timezone: 'UTC', todayUtc: '2026-09-30' });
 */
export async function computeActivityDay(
  db: Prisma.TransactionClient,
  args: { applicationId: string; day: string; timezone: string; todayUtc: string },
): Promise<ActivityDayData> {
  const { applicationId, day, timezone } = args;
  const { start, end } = dayWindow(day, timezone);
  const breakdown = emptyBreakdown();

  const grouped =
    timezone === 'UTC'
      ? await activityFromBits(db, applicationId, day, args.todayUtc)
      : await activityFromSessions(db, applicationId, day, timezone);
  let dau: number | null = null;
  let wau: number | null = null;
  let mau: number | null = null;
  for (const g of grouped) {
    const counts = { dau: Number(g.dau ?? 0), wau: Number(g.wau ?? 0), mau: Number(g.mau ?? 0) };
    if (g.gp && g.gc && g.gv) {
      ({ dau, wau, mau } = counts);
      continue;
    }
    const [dim, k]: [BreakdownDim, string] = !g.gp ? ['platform', key(g.platform)] : !g.gc ? ['country', key(g.country)] : ['via', key(g.via)];
    for (const field of ['dau', 'wau', 'mau'] as const) add(breakdown, dim, k, field, counts[field]);
  }

  const created = await db.$queryRaw<
    Array<{ gp: number; gc: number; gcv: number; platform: string | null; country: string | null; cv: string | null; n: bigint; verified: bigint }>
  >(Prisma.sql`
    SELECT GROUPING(eu."last_platform")::int AS gp, GROUPING(eu."last_country")::int AS gc,
           GROUPING(eu."created_via")::int AS gcv,
           eu."last_platform" AS platform, eu."last_country"::text AS country, eu."created_via" AS cv,
           count(*) AS n, count(*) FILTER (WHERE eu."email_verified") AS verified
      FROM "end_users" AS eu
     WHERE eu."application_id" = ${applicationId} AND eu."created_at" >= ${start} AND eu."created_at" < ${end}
     GROUP BY GROUPING SETS ((), (eu."last_platform"), (eu."last_country"), (eu."created_via"))`);
  let newUsers = 0;
  let newVerified = 0;
  for (const g of created) {
    const n = Number(g.n);
    if (g.gp && g.gc && g.gcv) {
      newUsers = n;
      newVerified = Number(g.verified);
    } else if (!g.gp) add(breakdown, 'platform', key(g.platform), 'newUsers', n);
    else if (!g.gc) add(breakdown, 'country', key(g.country), 'newUsers', n);
    else add(breakdown, 'createdVia', key(g.cv), 'newUsers', n);
  }

  const signIns = await db.$queryRaw<Group[]>(Prisma.sql`
    SELECT se."metadata"->>'via' AS key, count(*) AS n FROM "security_events" AS se
     WHERE se."application_id" = ${applicationId} AND se."type" = 'user.signed_in'
       AND se."created_at" >= ${start} AND se."created_at" < ${end}
     GROUP BY 1`);
  for (const g of signIns) add(breakdown, 'via', key(g.key), 'signIns', Number(g.n));

  const [onboarding] = await db.$queryRaw<Array<{ completed: bigint; skipped: bigint }>>(Prisma.sql`
    SELECT count(*) FILTER (WHERE eu."onboarding_completed_at" >= ${start} AND eu."onboarding_completed_at" < ${end}) AS completed,
           count(*) FILTER (WHERE eu."onboarding_skipped_at" >= ${start} AND eu."onboarding_skipped_at" < ${end}) AS skipped
      FROM "end_users" AS eu
     WHERE eu."application_id" = ${applicationId}
       AND (eu."onboarding_completed_at" IS NOT NULL OR eu."onboarding_skipped_at" IS NOT NULL)`);

  const usage = await db.$queryRaw<Group[]>(Prisma.sql`
    SELECT ur."meter_id" AS key, sum(ur."quantity") AS n
      FROM "usage_meters" AS um
      JOIN "usage_records" AS ur ON ur."meter_id" = um."id"
     WHERE um."application_id" = ${applicationId} AND ur."occurred_at" >= ${start} AND ur."occurred_at" < ${end}
     GROUP BY 1`);

  return {
    dau,
    wau,
    mau,
    newUsers,
    newVerified,
    signIns: signIns.reduce((s, g) => s + Number(g.n), 0),
    onboardingCompleted: Number(onboarding?.completed ?? 0),
    onboardingSkipped: Number(onboarding?.skipped ?? 0),
    breakdown,
    usageByMeter: Object.fromEntries(usage.filter((u) => u.key).map((u) => [u.key as string, Number(u.n)])),
  };
}
