/**
 * The analytics rollup: once an hour, recompute yesterday and today (in each
 * Application's reporting timezone) into `ApplicationActivityDay` and
 * today's `ApplicationPopulationSnapshot`.
 *
 * app.ts ticks every five minutes in every replica. A tick takes the
 * `lease:analytics-rollup` lease (lib/sweep-lease.ts) and skips when another
 * replica holds it, and an hour marker in Redis makes the work run once per
 * UTC hour. Everything is derived from rows already stored, so the job adds
 * no write to the sign-in or refresh path. Reads run read-only with a 30 s
 * statement budget, two Applications at a time, each isolated: one failing
 * logs and the rest still run.
 *
 * A day is `final` once it has been over for 15 minutes; a final row is
 * never rewritten, which is also how a reporting-timezone change applies to
 * new days only. The one exception is `usage_by_meter`, re-summed for the
 * last 45 days on every run because usage can be recorded late
 * (usage-resum.ts).
 */

import type { Redis } from 'ioredis';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { withReadOnlyBudget } from '../../../lib/read-budget.js';
import { withLease, type LeaseOutcome, type LeaseRedis } from '../../../lib/sweep-lease.js';
import { bumpCacheVersion } from '../../../lib/swr-cache.js';
import { addDays, todayIn } from '../range.js';
import { analyticsVersionKey } from '../timezone-change.js';
import { computeActivityDay } from './activity-day.js';
import { computePopulation } from './population.js';
import { dayWindow } from './day-window.js';
import { resumRecentUsage } from './usage-resum.js';
import { effectiveTimezone } from '../pg-timezones.js';

export const ROLLUP_LEASE_KEY = 'lease:analytics-rollup';
export const ROLLUP_LEASE_TTL_MS = 60_000;
export const ROLLUP_TICK_MS = 5 * 60 * 1000;
const STATEMENT_BUDGET_MS = 30_000;
const CONCURRENCY = 2;
const FINAL_AFTER_MS = 15 * 60 * 1000;

export interface RollupLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface RollupSummary {
  applications: number;
  failed: number;
  skippedHour: boolean;
}

function rollupTimeout(): RekeyError {
  return new RekeyError({
    statusCode: 503,
    code: 'ANALYTICS_TIMEOUT',
    message: 'An analytics rollup statement exceeded its 30 second budget.',
    fix: 'The next hourly run retries it. If it keeps failing for one Application, report it with the Application id.',
  });
}

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

function hourMarker(now: Date): string {
  return `rk:an:rollup:hour:${now.toISOString().slice(0, 13)}`;
}

/**
 * Recompute one Application's yesterday and today. Returns the days written.
 *
 * @example
 *   await rollupApplication(applicationId, new Date());
 */
export async function rollupApplication(applicationId: string, now: Date = new Date()): Promise<string[]> {
  const app = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    select: { reportingTimezone: true },
  });
  // A zone the database does not know (stored before that was checked) is
  // counted in UTC rather than failing every run.
  const { timezone } = await effectiveTimezone(app.reportingTimezone);
  const today = todayIn(timezone, now);
  const todayUtc = now.toISOString().slice(0, 10);
  const written: string[] = [];

  for (const day of [addDays(today, -1), today]) {
    const date = new Date(`${day}T00:00:00Z`);
    const existing = await prisma.applicationActivityDay.findUnique({
      where: { applicationId_day: { applicationId, day: date } },
      select: { final: true },
    });
    if (existing?.final) continue;
    const data = await withReadOnlyBudget(
      (tx) => computeActivityDay(tx, { applicationId, day, timezone, todayUtc }),
      { statementTimeoutMs: STATEMENT_BUDGET_MS, onTimeout: rollupTimeout },
    );
    const final = now.getTime() >= dayWindow(day, timezone).end.getTime() + FINAL_AFTER_MS;
    const row = {
      timezone,
      dau: data.dau,
      wau: data.wau,
      mau: data.mau,
      newUsers: data.newUsers,
      newVerified: data.newVerified,
      signIns: data.signIns,
      onboardingCompleted: data.onboardingCompleted,
      onboardingSkipped: data.onboardingSkipped,
      breakdown: json(data.breakdown),
      usageByMeter: json(data.usageByMeter),
      source: 'job',
      final,
      computedAt: now,
    };
    await prisma.applicationActivityDay.upsert({
      where: { applicationId_day: { applicationId, day: date } },
      create: { applicationId, day: date, ...row },
      update: row,
    });
    written.push(day);
  }

  const population = await withReadOnlyBudget((tx) => computePopulation(tx, applicationId), {
    statementTimeoutMs: STATEMENT_BUDGET_MS,
    onTimeout: rollupTimeout,
  });
  const takenOn = new Date(`${today}T00:00:00Z`);
  const snapshot = {
    timezone,
    ...population,
    cube: json(population.cube),
    onboarding: json(population.onboarding),
    byCountry: json(population.byCountry),
    byLastVia: json(population.byLastVia),
    byCreatedVia: json(population.byCreatedVia),
    oauthByProvider: json(population.oauthByProvider),
    liveSessions: json(population.liveSessions),
    planDistribution: json(population.planDistribution),
    computedAt: now,
  };
  await prisma.applicationPopulationSnapshot.upsert({
    where: { applicationId_takenOn: { applicationId, takenOn } },
    create: { applicationId, takenOn, ...snapshot },
    update: snapshot,
  });
  await resumRecentUsage(applicationId, now, { statementTimeoutMs: STATEMENT_BUDGET_MS, onTimeout: rollupTimeout });
  bumpCacheVersion(analyticsVersionKey(applicationId));
  return written;
}

/** Applications with at least one end user, in id order. */
async function applicationsWithUsers(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT a."id" FROM "applications" AS a
     WHERE EXISTS (SELECT 1 FROM "end_users" AS eu WHERE eu."application_id" = a."id")
     ORDER BY a."id"`;
  return rows.map((r) => r.id);
}

async function rollupAll(now: Date, log: RollupLogger): Promise<{ applications: number; failed: number }> {
  const ids = await applicationsWithUsers();
  let next = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next++]!;
      const started = Date.now();
      try {
        await rollupApplication(id, now);
        log.info({ applicationId: id, ms: Date.now() - started }, 'analytics rollup');
      } catch (err) {
        failed += 1;
        log.warn({ err, applicationId: id }, 'analytics rollup failed for one application');
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { applications: ids.length, failed };
}

/**
 * One tick of the timer. Runs at most once per UTC hour across all replicas.
 *
 * @example
 *   await runAnalyticsRollup(getRedis(), { log: app.log });
 */
export async function runAnalyticsRollup(
  redis: (LeaseRedis & Pick<Redis, 'get'>) | null,
  options: { log: RollupLogger; now?: Date; leaseKey?: string; force?: boolean },
): Promise<LeaseOutcome<RollupSummary>> {
  const now = options.now ?? new Date();
  return withLease(redis, { key: options.leaseKey ?? ROLLUP_LEASE_KEY, ttlMs: ROLLUP_LEASE_TTL_MS }, async () => {
    const marker = hourMarker(now);
    if (redis && !options.force && (await redis.get(marker))) {
      return { applications: 0, failed: 0, skippedHour: true };
    }
    const result = await rollupAll(now, options.log);
    if (redis) await redis.set(marker, '1', 'EX', 2 * 60 * 60).catch(() => undefined);
    return { ...result, skippedHour: false };
  });
}
