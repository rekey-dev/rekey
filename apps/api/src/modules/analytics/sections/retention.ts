/**
 * E: weekly retention for the last 8 weeks, from the activity bits.
 *
 * Cohort i is the users created in the 7 UTC days starting 55 - 7i days ago;
 * it counts as retained in week k if any of its members was active on one of
 * the 7 days of that week. All 8 × 8 cells lie inside the 63 days the bits
 * hold, so the triangle is exact. The range does not apply.
 */

import { Prisma } from '@prisma/client';
import type { AnalyticsRetention } from '@rekey.dev/shared-types';
import { userFilterSql } from '../filters.js';
import { addDays, daysBetween } from '../range.js';
import type { SectionContext, SectionResult, SectionSpec } from '../envelope.js';
import { BIT_WINDOW } from '../live-activity.js';
import { dayStart } from './kpis.js';

export const RETENTION_WEEKS = 8;
const WEEK_MASK = 127;

interface Cell {
  cohort: number;
  week: number;
  position: number;
}

async function computeRetention(
  db: Prisma.TransactionClient,
  ctx: SectionContext,
): Promise<SectionResult<AnalyticsRetention>> {
  const today = ctx.todayUtc;
  const firstStart = addDays(today, -(RETENTION_WEEKS * 7 - 1));
  const starts = Array.from({ length: RETENTION_WEEKS }, (_, i) => addDays(firstStart, i * 7));
  const cells: Cell[] = [];
  starts.forEach((start, cohort) => {
    for (let week = 0; cohort + week < RETENTION_WEEKS; week++) {
      const weekEnd = addDays(start, week * 7 + 6);
      cells.push({ cohort, week, position: daysBetween(weekEnd, today) });
    }
  });

  const cohortExpr = Prisma.raw(`LEAST(((c.day - DATE '${firstStart}') / 7), ${RETENTION_WEEKS - 1})`);
  const sizes = Array.from({ length: RETENTION_WEEKS }, (_, i) => Prisma.raw(`count(*) FILTER (WHERE cohort = ${i}) AS s${i}`));
  const retained = cells.map((cell, i) =>
    Prisma.raw(`count(*) FILTER (WHERE cohort = ${cell.cohort} AND ((a >> ${cell.position}) & ${WEEK_MASK}) <> 0) AS r${i}`),
  );

  const rows = await db.$queryRaw<Array<Record<string, bigint>>>(Prisma.sql`
    WITH c AS (
      SELECT (eu."created_at")::date AS day,
             CASE WHEN eu."activity_bits" IS NULL OR eu."last_active_on" IS NULL
                    OR ${today}::date - eu."last_active_on" >= ${BIT_WINDOW}
                  THEN 0::bigint
                  ELSE ((eu."activity_bits" << (${today}::date - eu."last_active_on"))::bigint) END AS a
        FROM "end_users" AS eu
       WHERE eu."application_id" = ${ctx.applicationId}
         AND eu."created_at" >= ${dayStart(firstStart)}
         ${userFilterSql(ctx.filters)}
    ),
    k AS (SELECT ${cohortExpr} AS cohort, a FROM c)
    SELECT ${Prisma.join([...sizes, ...retained], ', ')} FROM k
  `);
  const row = rows[0] ?? {};
  const tracked = ctx.trackedSince;
  return {
    kind: 'ok',
    source: 'live',
    timezone: 'UTC',
    data: {
      cohorts: starts.map((weekStart, cohort) => ({
        weekStart,
        size: Number(row[`s${cohort}`] ?? 0),
        retained: cells
          .map((cell, i) => ({ cell, i }))
          .filter(({ cell }) => cell.cohort === cohort)
          .map(({ cell, i }) => {
            const weekFirstDay = addDays(weekStart, cell.week * 7);
            if (tracked && weekFirstDay < tracked) return null;
            return Number(row[`r${i}`] ?? 0);
          }),
      })),
    },
  };
}

export const retentionSection: SectionSpec<AnalyticsRetention> = {
  name: 'retention',
  scope: 'overview:read',
  applies: 'all',
  freshSeconds: 5 * 60,
  compute: computeRetention,
};
