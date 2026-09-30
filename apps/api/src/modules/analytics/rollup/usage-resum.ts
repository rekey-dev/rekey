/**
 * Usage can be recorded late: `occurredAt` is the caller's, and a meter may
 * report a day that is already final. Each hourly run therefore re-sums
 * units per meter for every rolled-up day of the last `RESUM_DAYS` days,
 * which covers the whole current month and the Overview's 30-day window, and
 * rewrites `usage_by_meter` on the days whose totals moved. This is the one
 * field a final day may still change. The reads run under the caller's
 * statement budget, like every other rollup read.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { withReadOnlyBudget, type ReadBudget } from '../../../lib/read-budget.js';
import { addDays, todayIn } from '../range.js';
import { dayWindow } from './day-window.js';

export const RESUM_DAYS = 45;

function sameUsage(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

type UsageSum = { day: string; meter: string; n: bigint };

/** Summed units per local day and meter over `[start, end)`. */
function sumUsage(tx: Prisma.TransactionClient, applicationId: string, timezone: string, start: Date, end: Date) {
  return tx.$queryRaw<UsageSum[]>(Prisma.sql`
    SELECT to_char((ur."occurred_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS day,
           ur."meter_id" AS meter, sum(ur."quantity") AS n
      FROM "usage_meters" AS um
      JOIN "usage_records" AS ur ON ur."meter_id" = um."id"
     WHERE um."application_id" = ${applicationId}
       AND ur."occurred_at" >= ${start} AND ur."occurred_at" < ${end}
     GROUP BY 1, 2`);
}

/**
 * Re-sum usage for the Application's recent rollup days. Returns the days rewritten.
 *
 * @example
 *   await resumRecentUsage(applicationId, new Date(), { statementTimeoutMs: 30_000, onTimeout });
 */
export async function resumRecentUsage(applicationId: string, now: Date, budget: ReadBudget): Promise<string[]> {
  const since = addDays(now.toISOString().slice(0, 10), -RESUM_DAYS);
  const rows = await prisma.applicationActivityDay.findMany({
    where: { applicationId, day: { gte: new Date(`${since}T00:00:00Z`) } },
    select: { day: true, timezone: true, usageByMeter: true },
  });
  if (rows.length === 0) return [];
  const changed: string[] = [];
  for (const timezone of new Set(rows.map((r) => r.timezone))) {
    const days = rows.filter((r) => r.timezone === timezone).map((r) => r.day.toISOString().slice(0, 10)).sort();
    const start = dayWindow(days[0]!, timezone).start;
    const end = dayWindow(addDays(todayIn(timezone, now), 1), timezone).start;
    const sums = await withReadOnlyBudget((tx) => sumUsage(tx, applicationId, timezone, start, end), budget);
    const byDay = new Map<string, Record<string, number>>();
    for (const s of sums) (byDay.get(s.day) ?? byDay.set(s.day, {}).get(s.day)!)[s.meter] = Number(s.n);
    for (const row of rows.filter((r) => r.timezone === timezone)) {
      const day = row.day.toISOString().slice(0, 10);
      const fresh = byDay.get(day) ?? {};
      if (sameUsage(fresh, (row.usageByMeter as Record<string, number>) ?? {})) continue;
      await prisma.applicationActivityDay.update({
        where: { applicationId_day: { applicationId, day: row.day } },
        data: { usageByMeter: fresh as Prisma.InputJsonValue },
      });
      changed.push(day);
    }
  }
  return changed;
}
