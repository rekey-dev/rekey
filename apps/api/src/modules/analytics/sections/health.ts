/**
 * F security and account health (now), G billing counts and usage by meter.
 * Billing and usage need `billing:read` and are `unavailable` while billing
 * is off. None of them returns an amount of money.
 */

import { Prisma } from '@prisma/client';
import type { AnalyticsBillingCounts, AnalyticsSecurity, AnalyticsUsage } from '@rekey.dev/shared-types';
import { PAYING_STATUSES, activeFilterNames, userFilterSql } from '../filters.js';
import { addDays, daysBetween, eachDay } from '../range.js';
import { rollupDayValues } from '../rollup/read.js';
import type { SectionContext, SectionResult, SectionSpec } from '../envelope.js';
import { dayStart, ratio } from './kpis.js';

/** Usage is read live for at most this many days. */
export const LIVE_USAGE_DAYS = 7;

const BILLING_OFF = {
  kind: 'unavailable',
  reason: 'billing_disabled',
  fix: 'Turn billing on under Billing → Setup to see subscription and usage counts.',
} as const;

async function computeSecurity(db: Prisma.TransactionClient, ctx: SectionContext): Promise<SectionResult<AnalyticsSecurity>> {
  const app = ctx.applicationId;
  const filters = userFilterSql(ctx.filters);
  const [pop] = await db.$queryRaw<Array<{ total: bigint; verified: bigint; mfa: bigint }>>(Prisma.sql`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE eu."email_verified") AS verified,
           count(m."end_user_id") AS mfa
      FROM "end_users" AS eu
      LEFT JOIN "mfa_credentials" AS m ON m."end_user_id" = eu."id" AND m."enrolled_at" IS NOT NULL
     WHERE eu."application_id" = ${app}
       ${filters}`);
  const [passkeys] = await db.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(DISTINCT w."end_user_id") AS n
      FROM "webauthn_credentials" AS w
      JOIN "end_users" AS eu ON eu."id" = w."end_user_id"
     WHERE w."application_id" = ${app}
       ${filters}`);
  const devices = await db.$queryRaw<Array<{ status: string; n: bigint }>>(Prisma.sql`
    SELECT d."status"::text AS status, count(*) AS n
      FROM "devices" AS d
      JOIN "end_users" AS eu ON eu."id" = d."end_user_id"
     WHERE d."application_id" = ${app}
       ${filters}
     GROUP BY 1`);
  const snapshots = await db.applicationPopulationSnapshot.findMany({
    where: {
      applicationId: app,
      takenOn: { gte: new Date(`${ctx.range.from}T00:00:00Z`), lte: new Date(`${ctx.range.to}T00:00:00Z`) },
    },
    orderBy: { takenOn: 'asc' },
    select: { takenOn: true, timezone: true, total: true, verified: true, mfaUsers: true, passkeyUsers: true },
  });
  const total = Number(pop!.total);
  const device = (s: string): number => Number(devices.find((d) => d.status === s)?.n ?? 0);
  const part = (n: number) => ({ count: n, share: ratio(n, total) });
  return {
    kind: 'ok',
    source: 'live',
    timezone: 'UTC',
    data: {
      total,
      verified: part(Number(pop!.verified)),
      mfa: part(Number(pop!.mfa)),
      passkeys: part(Number(passkeys!.n)),
      devices: { active: device('ACTIVE'), blocked: device('BLOCKED'), released: device('RELEASED') },
      lockouts: {
        status: 'unavailable',
        reason: 'not_captured',
        fix: 'Failed sign-ins and lockouts are kept only by the rate limiter. See Activity for sign-in events.',
      },
      trendIgnoredFilters: activeFilterNames(ctx.filters),
      trend: snapshots.map((t) => ({
        date: t.takenOn.toISOString().slice(0, 10),
        timezone: t.timezone,
        total: t.total,
        verified: t.verified,
        mfa: t.mfaUsers,
        passkeys: t.passkeyUsers,
      })),
    },
  };
}

async function computeBilling(
  db: Prisma.TransactionClient,
  ctx: SectionContext,
): Promise<SectionResult<AnalyticsBillingCounts>> {
  if (!ctx.billingEnabled) return BILLING_OFF;
  const app = ctx.applicationId;
  const filters = userFilterSql(ctx.filters);
  const plans = await db.$queryRaw<Array<{ plan_id: string; plan_name: string; status: string; n: bigint }>>(Prisma.sql`
    SELECT s."plan_id", p."name" AS plan_name, s."status"::text AS status, count(*) AS n
      FROM "subscriptions" AS s
      JOIN "plans" AS p ON p."id" = s."plan_id"
      JOIN "end_users" AS eu ON eu."id" = s."end_user_id"
     WHERE s."application_id" = ${app}
       AND s."status"::text = ANY(${[...PAYING_STATUSES]}::text[])
       ${filters}
     GROUP BY 1, 2, 3
     ORDER BY n DESC, plan_name`);
  const now = new Date();
  const toEnd = dayStart(addDays(ctx.range.to, 1));
  const [trials] = await db.$queryRaw<Array<{ ended: bigint; converted: bigint }>>(Prisma.sql`
    SELECT count(*) AS ended, count(*) FILTER (WHERE s."status" = 'ACTIVE') AS converted
      FROM "subscriptions" AS s
      JOIN "end_users" AS eu ON eu."id" = s."end_user_id"
     WHERE s."application_id" = ${app}
       AND s."trial_ends_at" >= ${dayStart(ctx.range.from)}
       AND s."trial_ends_at" < ${toEnd < now ? toEnd : now}
       ${filters}`);
  const ended = Number(trials!.ended);
  const converted = Number(trials!.converted);
  return {
    kind: 'ok',
    source: 'live',
    timezone: 'UTC',
    data: {
      plans: plans.map((r) => ({ planId: r.plan_id, planName: r.plan_name, status: r.status, count: Number(r.n) })),
      trialConversion: { ended, converted, rate: ratio(converted, ended) },
    },
  };
}

async function usageFromRollup(db: Prisma.TransactionClient, ctx: SectionContext): Promise<SectionResult<AnalyticsUsage>> {
  const days = eachDay(ctx.range.from, ctx.range.to);
  const values = await rollupDayValues(db, ctx, days);
  const units = new Map<string, number>();
  for (const v of values.values()) {
    for (const [meter, n] of Object.entries(v.usageByMeter ?? {})) units.set(meter, (units.get(meter) ?? 0) + n);
  }
  const meters = await db.usageMeter.findMany({
    where: { applicationId: ctx.applicationId },
    select: { id: true, slug: true, name: true, unit: true },
  });
  return {
    kind: 'ok',
    source: 'rollup',
    timezone: ctx.range.timezone,
    data: {
      from: ctx.range.from,
      to: ctx.range.to,
      partial: [...values.values()].some((v) => v.usageByMeter === null),
      meters: meters
        .map((m) => ({ meterId: m.id, slug: m.slug, name: m.name, unit: m.unit, units: units.get(m.id) ?? 0 }))
        .filter((m) => m.units > 0)
        .sort((a, b) => b.units - a.units || a.slug.localeCompare(b.slug))
        .slice(0, 10),
    },
  };
}

async function computeUsage(db: Prisma.TransactionClient, ctx: SectionContext): Promise<SectionResult<AnalyticsUsage>> {
  if (!ctx.billingEnabled) return BILLING_OFF;
  if (ctx.mode === 'rollup') return usageFromRollup(db, ctx);
  const to = ctx.range.to;
  const span = Math.min(LIVE_USAGE_DAYS, ctx.range.days);
  const from = addDays(to, -(span - 1));
  const org = ctx.filters.org;
  const rows = await db.$queryRaw<Array<{ id: string; slug: string; name: string; unit: string; units: bigint | null }>>(
    Prisma.sql`
      SELECT um."id", um."slug", um."name", um."unit",
             (SELECT sum(ur."quantity") FROM "usage_records" AS ur
               WHERE ur."meter_id" = um."id"
                 AND ur."occurred_at" >= ${dayStart(from)}
                 AND ur."occurred_at" < ${dayStart(addDays(to, 1))}
                 ${org ? Prisma.sql`AND ur."organization_id" = ${org}` : Prisma.empty}) AS units
        FROM "usage_meters" AS um
       WHERE um."application_id" = ${ctx.applicationId}`,
  );
  return {
    kind: 'ok',
    source: 'live',
    timezone: 'UTC',
    data: {
      from,
      to,
      partial: daysBetween(from, to) + 1 < ctx.range.days,
      meters: rows
        .map((r) => ({ meterId: r.id, slug: r.slug, name: r.name, unit: r.unit, units: Number(r.units ?? 0) }))
        .filter((m) => m.units > 0)
        .sort((a, b) => b.units - a.units || a.slug.localeCompare(b.slug))
        .slice(0, 10),
    },
  };
}

export const securitySection: SectionSpec<AnalyticsSecurity> = {
  name: 'security',
  scope: 'overview:read',
  applies: ['platform', 'country', 'via', 'createdVia', 'onboarding', 'verified', 'mfa', 'plan', 'paying', 'org'],
  freshSeconds: 5 * 60,
  compute: computeSecurity,
};

export const billingSection: SectionSpec<AnalyticsBillingCounts> = {
  name: 'billing',
  scope: 'billing:read',
  applies: 'all',
  freshSeconds: 60,
  compute: computeBilling,
};

export const usageSection: SectionSpec<AnalyticsUsage> = {
  name: 'usage',
  scope: 'billing:read',
  applies: ['org'],
  freshSeconds: 5 * 60,
  compute: computeUsage,
};
