/**
 * Super-admin metrics service.
 *
 * Pure READ aggregations across the whole deployment for the operator
 * dashboard at admin.rekey.dev. Every method is a `findMany`/`count`/
 * `groupBy` over Prisma, no writes, no caching. The dashboard runs at low
 * cadence (operator-driven page loads), so we avoid materialised views and
 * compute on demand.
 *
 * Performance shape: every list endpoint takes a small `limit` (default 50,
 * max 200). The overview rolls up counts in parallel with `Promise.all`.
 */

import type { AppEnvironment } from '@rekey.dev/shared-types';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { cachedDashboard } from '../../lib/dashboard-cache.js';
import { paged, type Paged } from '../../lib/pagination.js';
import { getRedis } from '../../lib/redis.js';
import {
  scanActiveLoginLocks,
  scanActiveOperatorLoginLocks,
  LOGIN_POLICY,
} from '../../lib/brute-force.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function clampLimit(raw: number | undefined, def = 50, max = 200): number {
  if (raw === undefined || Number.isNaN(raw)) return def;
  return Math.min(Math.max(1, Math.floor(raw)), max);
}

function clampOffset(raw: number | undefined): number {
  if (raw === undefined || Number.isNaN(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}

/**
 * One page of a list endpoint: `{items, page}`, the same `{items, page:
 * PageMeta}` shape every list endpoint in the API returns, aliased through
 * `lib/pagination.ts` so there is exactly one definition of it.
 *
 * `page.total` is the full count of matching rows (independent of
 * limit/offset) so the UI can render a "first to last of total" range plus page nav.
 */
export type Page<T> = Paged<T>;

/**
 * Upper bound on rows scanned for a COMPUTED-sort page (MRR, end-user count,
 * last-activity, values that aren't DB columns, so we sort in JS). The window
 * must cover `offset + limit`; beyond this cap, deep pages of a computed sort
 * are not materialised (acceptable: a deployment with 500+ tenants would want
 * a materialised ranking, not an on-demand fan-out). DB-column sorts use real
 * `skip`/`take` and are unaffected by this.
 */
const COMPUTED_SCAN_CAP = 500;

/**
 * Common shape for list-endpoint queries: limit + free-text search + sort.
 *
 * Sort fields differ per resource (each method narrows its own union), so the
 * `sort` value is opaque at this layer. `order` defaults to `desc` because
 * most "recent first" and "biggest first" feel natural.
 */
export interface ListQuery<S extends string = string> {
  // `| undefined` on each, Zod's `.optional()` produces `T | undefined` which
  // under `exactOptionalPropertyTypes: true` (root tsconfig) is *not* assignable
  // to a bare `T?` property. Spelling it out keeps the route layer's parsed
  // `req.query` shape assignable straight into these signatures.
  limit?: number | undefined;
  /** Row offset for pagination (0-based). Defaults to 0. */
  offset?: number | undefined;
  q?: string | undefined;
  sort?: S | undefined;
  order?: 'asc' | 'desc' | undefined;
}

/**
 * Sort a JS array in place by a numeric or string field. Used after the
 * Prisma-side fetch when the sort key is a computed value (MRR, end-user
 * count, etc.) that isn't a column. Stable enough for the dashboard's needs.
 */
function sortByField<T>(rows: T[], field: keyof T, order: 'asc' | 'desc'): T[] {
  const sign = order === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign;
    return (av > bv ? 1 : -1) * sign;
  });
}

export interface OverviewMetrics {
  tenants: { total: number; newLast30d: number };
  applications: { total: number; newLast30d: number };
  endUsers: { total: number; verified: number; newLast24h: number; newLast7d: number; newLast30d: number };
  organizations: { total: number; newLast30d: number };
  subscriptions: {
    pending: number;
    active: number;
    pastDue: number;
    canceled: number;
    expired: number;
    total: number;
  };
  payments: {
    lifetime: { count: number; volumeCents: number };
    last30d: { count: number; volumeCents: number };
    succeededLast24h: number;
    failedLast24h: number;
  };
  mrrCents: number;
  /**
   * `true` when `computeMrrCents()` saturated its `take:` cap and the value is
   * therefore a lower bound, not the truth. UI surfaces a warning when set so
   * the operator doesn't trust a silently-undercounted MRR.
   */
  mrrCapped: boolean;
  webhooks: { eventsLast24h: number; deliveriesLast24h: number; deliveriesFailedLast24h: number };
  apiRequests: { last24h: number; errors4xxLast24h: number; errors5xxLast24h: number; avgDurationMs: number };
  tenantUsers: { total: number; activeLast30d: number };
  /**
   * Number of end-user accounts currently inside the failed-sign-in lockout
   * window. Sourced from the Redis brute-force limiter (`bf:lock:eu:login:*`),
   * which is the only source, the `EndUser.lockedUntil` column this used to
   * read was dropped on 2026-07-30. See `scanActiveLoginLocks`.
   */
  lockedAccountsCount: number;
  /** SUM(CreditBalance.balance) across all applications. Unit-less. */
  outstandingCredits: number;
  /** Email-deliverability summary over the last 24h. */
  emailLast24h: { sent: number; error: number; noTransport: number; total: number };
}

/** Max active subs we read for MRR computation in a single call. */
const MRR_READ_CAP = 10_000;

async function computeMrrCents(): Promise<{ totalCents: number; capped: boolean }> {
  // ACTIVE subscriptions, joined to their plan. Convert YEAR pricing to monthly.
  // Cap the read at a sane page size, a deployment with MRR_READ_CAP+ active
  // subs would want a materialised total, but we're not there. We return
  // `capped: true` so the caller can surface a "this is a lower bound" warning
  // instead of silently undercounting forever once we cross the threshold.
  const rows = await prisma.subscription.findMany({
    where: { status: 'ACTIVE' },
    select: { plan: { select: { amount: true, interval: true } } },
    take: MRR_READ_CAP,
  });
  let total = 0;
  for (const r of rows) {
    if (!r.plan) continue;
    total += r.plan.interval === 'YEAR' ? Math.floor(r.plan.amount / 12) : r.plan.amount;
  }
  return { totalCents: total, capped: rows.length === MRR_READ_CAP };
}

/**
 * Row count per application over `ids`, one grouped query. The table name is
 * one of a fixed set chosen by the caller, never user input.
 */
async function countByApplication(
  table: 'end_users' | 'organizations',
  ids: string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ application_id: string; n: bigint }>>(Prisma.sql`
    SELECT "application_id", count(*) AS n
    FROM ${Prisma.raw(`"${table}"`)}
    WHERE "application_id" = ANY(${ids}::text[])
    GROUP BY "application_id"
  `);
  return new Map(rows.map((r) => [r.application_id, Number(r.n)]));
}

/**
 * ACTIVE subscriptions per application, with their monthly recurring value
 * (YEAR plans at a twelfth, floored per subscription as before), in one query.
 */
async function activeSubscriptionsByApplication(
  ids: string[],
): Promise<Map<string, { count: number; mrrCents: number }>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<
    Array<{ application_id: string; n: bigint; mrr: bigint | null }>
  >(Prisma.sql`
    SELECT s."application_id",
           count(*) AS n,
           sum(CASE WHEN p."interval" = 'YEAR' THEN p."amount" / 12 ELSE p."amount" END) AS mrr
    FROM "subscriptions" s
    JOIN "plans" p ON p."id" = s."plan_id"
    WHERE s."status" = 'ACTIVE' AND s."application_id" = ANY(${ids}::text[])
    GROUP BY s."application_id"
  `);
  return new Map(
    rows.map((r) => [r.application_id, { count: Number(r.n), mrrCents: Number(r.mrr ?? 0) }]),
  );
}

/** API requests per application since `since`, one grouped query. */
async function requestsSinceByApplication(ids: string[], since: Date): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ application_id: string; n: bigint }>>(Prisma.sql`
    SELECT "application_id", count(*) AS n
    FROM "api_request_logs"
    WHERE "application_id" = ANY(${ids}::text[]) AND "created_at" >= ${since}
    GROUP BY "application_id"
  `);
  return new Map(rows.map((r) => [r.application_id, Number(r.n)]));
}

/**
 * Newest API request per application. A LATERAL `ORDER BY ... LIMIT 1` per id
 * rides the (application_id, created_at) index backwards, where a GROUP BY
 * max() would read every log row the applications ever wrote.
 */
async function lastRequestByApplication(ids: string[]): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ application_id: string; created_at: Date }>>(Prisma.sql`
    SELECT x.id AS application_id, l."created_at"
    FROM unnest(${ids}::text[]) AS x(id)
    CROSS JOIN LATERAL (
      SELECT "created_at" FROM "api_request_logs"
      WHERE "application_id" = x.id
      ORDER BY "created_at" DESC
      LIMIT 1
    ) l
  `);
  return new Map(rows.map((r) => [r.application_id, r.created_at]));
}

export const adminMetricsService = {
  /**
   * The deployment rollup. Cached in Redis for 60s under `rk:admin:overview`
   * (lib/dashboard-cache.ts): it counts the largest tables whole, the console
   * reloads it on every visit, and a minute of lag on a rollup is harmless.
   * `computeOverview` is the uncached read.
   */
  async overview(): Promise<OverviewMetrics> {
    return cachedDashboard('rk:admin:overview', 60, () => adminMetricsService.computeOverview());
  },

  async computeOverview(): Promise<OverviewMetrics> {
    const now = new Date();
    const since24h = new Date(now.getTime() - DAY_MS);
    const since7d = new Date(now.getTime() - 7 * DAY_MS);
    const since30d = new Date(now.getTime() - 30 * DAY_MS);

    // The plain counts are one statement: each table scanned once, its
    // numbers taken with `count(*) FILTER (...)`. This used to be 22 separate
    // count queries fired at once, which alone could hold most of the pool.
    const [countsRows, subsGrouped, mrrCents, tenantUsersActive30d, lockedAccountsCount, emailGrouped24h] =
      await Promise.all([
        prisma.$queryRaw<Array<Record<string, bigint | number | null>>>(Prisma.sql`
          SELECT
            t.total AS tenants_total, t.new_30d AS tenants_new_30d,
            a.total AS apps_total, a.new_30d AS apps_new_30d,
            eu.total AS eu_total, eu.verified AS eu_verified,
            eu.new_24h AS eu_new_24h, eu.new_7d AS eu_new_7d, eu.new_30d AS eu_new_30d,
            o.total AS orgs_total, o.new_30d AS orgs_new_30d,
            p.lifetime_count AS pay_lifetime_count, p.lifetime_sum AS pay_lifetime_sum,
            p.last30_count AS pay_last30_count, p.last30_sum AS pay_last30_sum,
            p.succeeded_24h AS pay_succeeded_24h, p.failed_24h AS pay_failed_24h,
            (SELECT count(*) FROM "webhook_events" WHERE "received_at" >= ${since24h}) AS wh_events_24h,
            wd.total AS wh_deliveries_24h, wd.failed AS wh_deliveries_failed_24h,
            r.total AS req_24h, r.e4 AS req_4xx_24h, r.e5 AS req_5xx_24h, r.avg_ms AS req_avg_ms,
            (SELECT count(*) FROM "tenant_users") AS tenant_users_total,
            (SELECT sum("balance") FROM "credit_balances") AS credits_outstanding
          FROM
            (SELECT count(*) AS total, count(*) FILTER (WHERE "created_at" >= ${since30d}) AS new_30d
               FROM "tenants") t,
            (SELECT count(*) AS total, count(*) FILTER (WHERE "created_at" >= ${since30d}) AS new_30d
               FROM "applications") a,
            (SELECT count(*) AS total,
                    count(*) FILTER (WHERE "email_verified") AS verified,
                    count(*) FILTER (WHERE "created_at" >= ${since24h}) AS new_24h,
                    count(*) FILTER (WHERE "created_at" >= ${since7d}) AS new_7d,
                    count(*) FILTER (WHERE "created_at" >= ${since30d}) AS new_30d
               FROM "end_users") eu,
            (SELECT count(*) AS total, count(*) FILTER (WHERE "created_at" >= ${since30d}) AS new_30d
               FROM "organizations") o,
            (SELECT count(*) FILTER (WHERE "status" = 'SUCCEEDED') AS lifetime_count,
                    sum("amount") FILTER (WHERE "status" = 'SUCCEEDED') AS lifetime_sum,
                    count(*) FILTER (WHERE "status" = 'SUCCEEDED' AND "created_at" >= ${since30d}) AS last30_count,
                    sum("amount") FILTER (WHERE "status" = 'SUCCEEDED' AND "created_at" >= ${since30d}) AS last30_sum,
                    count(*) FILTER (WHERE "status" = 'SUCCEEDED' AND "created_at" >= ${since24h}) AS succeeded_24h,
                    count(*) FILTER (WHERE "status" = 'FAILED' AND "created_at" >= ${since24h}) AS failed_24h
               FROM "payments" WHERE "status" IN ('SUCCEEDED', 'FAILED')) p,
            (SELECT count(*) AS total, count(*) FILTER (WHERE "status" = 'FAILED') AS failed
               FROM "webhook_deliveries" WHERE "created_at" >= ${since24h}) wd,
            (SELECT count(*) AS total,
                    count(*) FILTER (WHERE "status_code" >= 400 AND "status_code" < 500) AS e4,
                    count(*) FILTER (WHERE "status_code" >= 500) AS e5,
                    avg("duration_ms") AS avg_ms
               FROM "api_request_logs" WHERE "created_at" >= ${since24h}) r
        `),
        prisma.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
        computeMrrCents(),
        // "Active" operator = had a refresh token created in the last 30 days.
        // Equivalent of a sign-in event since refresh rotation also writes here.
        prisma.tenantUser.count({
          where: { refreshTokens: { some: { createdAt: { gte: since30d } } } },
        }),
        // End-user lockouts in effect right now (failed sign-in protection).
        // Lockout lives in the Redis brute-force limiter, not a DB column,
        // enumerate the `bf:lock:eu:login:*` keys. limit:0 → count only.
        scanActiveLoginLocks(0).then((r) => r.total),
        prisma.emailLog.groupBy({
          by: ['status'],
          where: { createdAt: { gte: since24h } },
          _count: { _all: true },
        }),
      ]);
    const c = countsRows[0] ?? {};
    const num = (k: string): number => Number(c[k] ?? 0);

    // Roll the email grouping into the overview's tiny rollup shape. Full
    // detail lives behind `/api/v1/admin/metrics/email-deliverability`.
    const emailMap = Object.fromEntries(emailGrouped24h.map((r) => [r.status, r._count._all])) as Record<string, number>;
    const emailLast24h = {
      sent: emailMap.sent ?? 0,
      error: emailMap.error ?? 0,
      noTransport: emailMap.no_transport ?? 0,
      // The fourth outcome. Left out of the total, a workspace that switches
      // email off reports a shrinking volume rather than a redirected one.
      suppressed: emailMap.suppressed ?? 0,
      total:
        (emailMap.sent ?? 0) +
        (emailMap.error ?? 0) +
        (emailMap.no_transport ?? 0) +
        (emailMap.suppressed ?? 0),
    };

    const subsByStatus = Object.fromEntries(subsGrouped.map((g) => [g.status, g._count._all])) as Record<string, number>;

    return {
      tenants: { total: num('tenants_total'), newLast30d: num('tenants_new_30d') },
      applications: { total: num('apps_total'), newLast30d: num('apps_new_30d') },
      endUsers: {
        total: num('eu_total'),
        verified: num('eu_verified'),
        newLast24h: num('eu_new_24h'),
        newLast7d: num('eu_new_7d'),
        newLast30d: num('eu_new_30d'),
      },
      organizations: { total: num('orgs_total'), newLast30d: num('orgs_new_30d') },
      subscriptions: {
        pending: subsByStatus.PENDING ?? 0,
        active: subsByStatus.ACTIVE ?? 0,
        pastDue: subsByStatus.PAST_DUE ?? 0,
        canceled: subsByStatus.CANCELED ?? 0,
        expired: subsByStatus.EXPIRED ?? 0,
        total: Object.values(subsByStatus).reduce((a, b) => a + b, 0),
      },
      payments: {
        lifetime: { count: num('pay_lifetime_count'), volumeCents: num('pay_lifetime_sum') },
        last30d: { count: num('pay_last30_count'), volumeCents: num('pay_last30_sum') },
        succeededLast24h: num('pay_succeeded_24h'),
        failedLast24h: num('pay_failed_24h'),
      },
      mrrCents: mrrCents.totalCents,
      mrrCapped: mrrCents.capped,
      webhooks: {
        eventsLast24h: num('wh_events_24h'),
        deliveriesLast24h: num('wh_deliveries_24h'),
        deliveriesFailedLast24h: num('wh_deliveries_failed_24h'),
      },
      apiRequests: {
        last24h: num('req_24h'),
        errors4xxLast24h: num('req_4xx_24h'),
        errors5xxLast24h: num('req_5xx_24h'),
        avgDurationMs: Math.round(num('req_avg_ms')),
      },
      tenantUsers: { total: num('tenant_users_total'), activeLast30d: tenantUsersActive30d },
      lockedAccountsCount,
      outstandingCredits: num('credits_outstanding'),
      emailLast24h,
    };
  },

  async services(): Promise<{
    api: { status: 'up' | 'down'; checkedAt: string };
    database: { status: 'up' | 'down'; latencyMs: number | null };
    redis: { status: 'up' | 'down' | 'not_configured'; latencyMs: number | null };
    webhookDeliverySuccessRate24h: number | null;
    oldestUnprocessedWebhookAgeSeconds: number | null;
  }> {
    const now = new Date();
    const since24h = new Date(now.getTime() - DAY_MS);

    // DB ping.
    let dbStatus: 'up' | 'down';
    let dbLatency: number | null = null;
    const dbT0 = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbStatus = 'up';
      dbLatency = Date.now() - dbT0;
    } catch {
      dbStatus = 'down';
    }

    // Redis ping. `getRedis()` may return null (NODE_ENV=test, or not configured).
    let redisStatus: 'up' | 'down' | 'not_configured' = 'not_configured';
    let redisLatency: number | null = null;
    const redis = getRedis();
    if (redis) {
      const rT0 = Date.now();
      try {
        const pong = await redis.ping();
        redisStatus = pong === 'PONG' ? 'up' : 'down';
        redisLatency = Date.now() - rT0;
      } catch {
        redisStatus = 'down';
      }
    }

    // Outbound webhook success rate over the last 24h.
    const [total24h, succeeded24h] = await Promise.all([
      prisma.webhookDelivery.count({ where: { createdAt: { gte: since24h } } }),
      prisma.webhookDelivery.count({ where: { createdAt: { gte: since24h }, status: 'SUCCEEDED' } }),
    ]);
    const successRate = total24h === 0 ? null : succeeded24h / total24h;

    // Oldest inbound webhook still unprocessed, surfaces stuck queues.
    const oldestPending = await prisma.webhookEvent.findFirst({
      where: { processedAt: null },
      orderBy: { receivedAt: 'asc' },
      select: { receivedAt: true },
    });
    const oldestAgeSeconds = oldestPending
      ? Math.floor((now.getTime() - oldestPending.receivedAt.getTime()) / 1000)
      : null;

    return {
      api: { status: 'up', checkedAt: now.toISOString() },
      database: { status: dbStatus, latencyMs: dbLatency },
      redis: { status: redisStatus, latencyMs: redisLatency },
      webhookDeliverySuccessRate24h: successRate,
      oldestUnprocessedWebhookAgeSeconds: oldestAgeSeconds,
    };
  },

  async retention(): Promise<{
    endUsersActive: { last24h: number; last7d: number; last30d: number };
    operatorsActive: { last24h: number; last7d: number; last30d: number };
    signupTrend14d: Array<{ date: string; count: number }>;
  }> {
    const now = new Date();
    const since24h = new Date(now.getTime() - DAY_MS);
    const since7d = new Date(now.getTime() - 7 * DAY_MS);
    const since30d = new Date(now.getTime() - 30 * DAY_MS);

    const [
      euActive24h,
      euActive7d,
      euActive30d,
      opActive24h,
      opActive7d,
      opActive30d,
    ] = await Promise.all([
      // RefreshToken.createdAt is the closest proxy for "active end-user", a
      // token is created on sign-in and on each rotation, so an active user
      // generates fresh rows continually. We groupBy endUserId to count distinct.
      prisma.refreshToken
        .groupBy({ by: ['endUserId'], where: { createdAt: { gte: since24h } } })
        .then((g) => g.length),
      prisma.refreshToken
        .groupBy({ by: ['endUserId'], where: { createdAt: { gte: since7d } } })
        .then((g) => g.length),
      prisma.refreshToken
        .groupBy({ by: ['endUserId'], where: { createdAt: { gte: since30d } } })
        .then((g) => g.length),
      prisma.tenantRefreshToken
        .groupBy({ by: ['tenantUserId'], where: { createdAt: { gte: since24h } } })
        .then((g) => g.length),
      prisma.tenantRefreshToken
        .groupBy({ by: ['tenantUserId'], where: { createdAt: { gte: since7d } } })
        .then((g) => g.length),
      prisma.tenantRefreshToken
        .groupBy({ by: ['tenantUserId'], where: { createdAt: { gte: since30d } } })
        .then((g) => g.length),
    ]);

    // 14-day signup trend: bucket new end-users by UTC day. We do this in SQL
    // for a single round-trip rather than per-day count queries.
    const since14d = new Date(now.getTime() - 14 * DAY_MS);
    const rows = await prisma.$queryRaw<Array<{ date: Date; count: bigint }>>`
      SELECT date_trunc('day', "created_at") AS date, COUNT(*)::bigint AS count
      FROM end_users
      WHERE "created_at" >= ${since14d}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    const trend = rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      count: Number(r.count),
    }));

    return {
      endUsersActive: { last24h: euActive24h, last7d: euActive7d, last30d: euActive30d },
      operatorsActive: { last24h: opActive24h, last7d: opActive7d, last30d: opActive30d },
      signupTrend14d: trend,
    };
  },

  async tenants(
    query: ListQuery<'createdAt' | 'name' | 'mrrCents' | 'endUserCount' | 'applicationCount' | 'lastActivityAt'> = {},
  ): Promise<
    Page<{
      id: string;
      name: string;
      ownerEmail: string;
      applicationCount: number;
      endUserCount: number;
      organizationCount: number;
      activeSubscriptions: number;
      mrrCents: number;
      /** Always false since the per-tenant MRR is summed in SQL; kept for clients that read it. */
      mrrCapped: boolean;
      createdAt: string;
      lastActivityAt: string | null;
    }>
  > {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const q = query.q?.trim();
    // DB-side filter on the columns that exist on Tenant. Computed-aggregate
    // sort happens after the per-tenant fan-out below.
    const where = q
      ? {
          OR: [
            { id: q },
            { name: { contains: q, mode: 'insensitive' as const } },
            { ownerEmail: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {};
    // When sorting on a computed field (MRR / endUserCount / applicationCount /
    // lastActivityAt) we need to enrich more than `limit` rows before sorting,
    // otherwise top-N by MRR could be wrong if the top earners are older.
    const isComputedSort =
      query.sort === 'mrrCents' ||
      query.sort === 'endUserCount' ||
      query.sort === 'applicationCount' ||
      query.sort === 'lastActivityAt';
    // DB-column sort → real skip/take (one page). Computed sort → scan a
    // window from the top, enrich, JS-sort, then slice the page out of it.
    const fetchSkip = isComputedSort ? 0 : offset;
    const fetchTake = isComputedSort
      ? Math.min(Math.max(offset + limit, limit), COMPUTED_SCAN_CAP)
      : limit;
    const [total, tenants] = await Promise.all([
      prisma.tenant.count({ where }),
      prisma.tenant.findMany({
        where,
        orderBy:
          query.sort === 'name'
            ? { name: query.order ?? 'asc' }
            : { createdAt: query.order ?? 'desc' },
        skip: fetchSkip,
        take: fetchTake,
        include: {
          applications: {
            select: { id: true },
          },
        },
      }),
    ]);

    // One grouped query per metric over every listed tenant's applications,
    // not five queries per tenant: a computed sort scans up to
    // COMPUTED_SCAN_CAP tenants, which was up to 2,500 queries at once.
    const appIds = tenants.flatMap((t) => t.applications.map((a) => a.id));
    const [endUsers, orgs, subs, lastSeen] = await Promise.all([
      countByApplication('end_users', appIds),
      countByApplication('organizations', appIds),
      activeSubscriptionsByApplication(appIds),
      lastRequestByApplication(appIds),
    ]);
    const enriched = tenants.map((t) => {
      const ids = t.applications.map((a) => a.id);
      let endUserCount = 0;
      let organizationCount = 0;
      let activeSubscriptions = 0;
      let mrrCents = 0;
      let last: Date | null = null;
      for (const id of ids) {
        endUserCount += endUsers.get(id) ?? 0;
        organizationCount += orgs.get(id) ?? 0;
        activeSubscriptions += subs.get(id)?.count ?? 0;
        mrrCents += subs.get(id)?.mrrCents ?? 0;
        const seen = lastSeen.get(id);
        if (seen && (last === null || seen > last)) last = seen;
      }
      return {
        id: t.id,
        name: t.name,
        ownerEmail: t.ownerEmail,
        applicationCount: ids.length,
        endUserCount,
        organizationCount,
        activeSubscriptions,
        mrrCents,
        // Summed in SQL over every active subscription, so no longer capped.
        // Kept in the shape for clients that read it.
        mrrCapped: false,
        createdAt: t.createdAt.toISOString(),
        lastActivityAt: last?.toISOString() ?? null,
      };
    });

    // Post-aggregate sort for computed fields, then slice out the requested
    // page window. DB-column sort already returned exactly the page.
    const items =
      isComputedSort && query.sort
        ? sortByField(enriched, query.sort as keyof (typeof enriched)[number], query.order ?? 'desc').slice(
            offset,
            offset + limit,
          )
        : enriched;
    return paged(items, total, limit, offset);
  },

  async applications(
    query: ListQuery<'createdAt' | 'name' | 'slug' | 'endUserCount' | 'activeSubscriptions' | 'apiRequestsLast24h'> & {
      tenantId?: string | undefined;
    } = {},
  ): Promise<
    Page<{
      id: string;
      tenantId: string;
      tenantName: string;
      name: string;
      slug: string;
      environment: AppEnvironment;
      endUserCount: number;
      activeSubscriptions: number;
      apiRequestsLast24h: number;
      createdAt: string;
    }>
  > {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const since24h = new Date(Date.now() - DAY_MS);
    const q = query.q?.trim();
    const where = {
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(q
        ? {
            OR: [
              { id: q },
              { name: { contains: q, mode: 'insensitive' as const } },
              { slug: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const isComputedSort =
      query.sort === 'endUserCount' ||
      query.sort === 'activeSubscriptions' ||
      query.sort === 'apiRequestsLast24h';
    const fetchSkip = isComputedSort ? 0 : offset;
    const fetchTake = isComputedSort
      ? Math.min(Math.max(offset + limit, limit), COMPUTED_SCAN_CAP)
      : limit;
    const [total, apps] = await Promise.all([
      prisma.application.count({ where }),
      prisma.application.findMany({
        where,
        orderBy:
          query.sort === 'name'
            ? { name: query.order ?? 'asc' }
            : query.sort === 'slug'
              ? { slug: query.order ?? 'asc' }
              : { createdAt: query.order ?? 'desc' },
        skip: fetchSkip,
        take: fetchTake,
        include: { tenant: { select: { name: true } } },
      }),
    ]);
    // One grouped query per metric over the listed ids, not three per row: a
    // computed sort scans up to COMPUTED_SCAN_CAP rows, which was up to 1,500
    // queries at once against a 20-connection pool.
    const ids = apps.map((a) => a.id);
    const [endUsers, subs, requests] = await Promise.all([
      countByApplication('end_users', ids),
      activeSubscriptionsByApplication(ids),
      requestsSinceByApplication(ids, since24h),
    ]);
    const enriched = apps.map((a) => ({
      id: a.id,
      tenantId: a.tenantId,
      tenantName: a.tenant.name,
      name: a.name,
      slug: a.slug,
      // The deployment owner sees every tenant's applications side by side;
      // with data modes gone this is the only marker of which ones are real.
      environment: a.environment,
      endUserCount: endUsers.get(a.id) ?? 0,
      activeSubscriptions: subs.get(a.id)?.count ?? 0,
      apiRequestsLast24h: requests.get(a.id) ?? 0,
      createdAt: a.createdAt.toISOString(),
    }));
    const items =
      isComputedSort && query.sort
        ? sortByField(enriched, query.sort as keyof (typeof enriched)[number], query.order ?? 'desc').slice(
            offset,
            offset + limit,
          )
        : enriched;
    return paged(items, total, limit, offset);
  },

  async endUsers(
    query: ListQuery<'createdAt' | 'email' | 'lastSeenAt'> & { applicationId?: string | undefined } = {},
  ): Promise<
    Page<{
      id: string;
      applicationId: string;
      applicationSlug: string;
      applicationName: string;
      email: string;
      emailVerified: boolean;
      role: string;
      createdAt: string;
      lastSeenAt: string | null;
    }>
  > {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const q = query.q?.trim();
    const where = {
      ...(query.applicationId ? { applicationId: query.applicationId } : {}),
      ...(q
        ? {
            OR: [
              { id: q },
              { email: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const isComputedSort = query.sort === 'lastSeenAt';
    const fetchSkip = isComputedSort ? 0 : offset;
    const fetchTake = isComputedSort
      ? Math.min(Math.max(offset + limit, limit), COMPUTED_SCAN_CAP)
      : limit;
    const [total, users] = await Promise.all([
      prisma.endUser.count({ where }),
      prisma.endUser.findMany({
        where,
        orderBy:
          query.sort === 'email'
            ? { email: query.order ?? 'asc' }
            : { createdAt: query.order ?? 'desc' },
        skip: fetchSkip,
        take: fetchTake,
        include: {
          application: { select: { slug: true, name: true } },
          refreshTokens: {
            select: { createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
    ]);
    const enriched = users.map((u) => ({
      id: u.id,
      applicationId: u.applicationId,
      applicationSlug: u.application.slug,
      applicationName: u.application.name,
      email: u.email,
      emailVerified: u.emailVerified,
      role: u.role,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: u.refreshTokens[0]?.createdAt.toISOString() ?? null,
    }));
    const items = isComputedSort
      ? sortByField(enriched, 'lastSeenAt', query.order ?? 'desc').slice(offset, offset + limit)
      : enriched;
    return paged(items, total, limit, offset);
  },

  async tenantUsers(
    query: ListQuery<'createdAt' | 'email' | 'lastSeenAt'> = {},
  ): Promise<
    Page<{
      id: string;
      email: string;
      name: string | null;
      emailVerified: boolean;
      createdAt: string;
      lastSeenAt: string | null;
      membershipCount: number;
    }>
  > {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const q = query.q?.trim();
    const where = q
      ? {
          OR: [
            { id: q },
            { email: { contains: q, mode: 'insensitive' as const } },
            { name: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {};
    const isComputedSort = query.sort === 'lastSeenAt';
    const fetchSkip = isComputedSort ? 0 : offset;
    const fetchTake = isComputedSort
      ? Math.min(Math.max(offset + limit, limit), COMPUTED_SCAN_CAP)
      : limit;
    const [total, users] = await Promise.all([
      prisma.tenantUser.count({ where }),
      prisma.tenantUser.findMany({
        where,
        orderBy:
          query.sort === 'email'
            ? { email: query.order ?? 'asc' }
            : { createdAt: query.order ?? 'desc' },
        skip: fetchSkip,
        take: fetchTake,
        include: {
          memberships: { select: { id: true } },
          refreshTokens: {
            select: { createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
    ]);
    const enriched = users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      emailVerified: u.emailVerified,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: u.refreshTokens[0]?.createdAt.toISOString() ?? null,
      membershipCount: u.memberships.length,
    }));
    const items = isComputedSort
      ? sortByField(enriched, 'lastSeenAt', query.order ?? 'desc').slice(offset, offset + limit)
      : enriched;
    return paged(items, total, limit, offset);
  },

  async securityEvents(
    query: ListQuery<'createdAt'> & {
      actorType?: string | undefined;
      type?: string | undefined;
      tenantId?: string | undefined;
      applicationId?: string | undefined;
      ip?: string | undefined;
    } = {},
  ): Promise<
    Page<{
      id: string;
      type: string;
      actorType: string;
      actorId: string | null;
      tenantId: string | null;
      /** Resolved tenant name (null if the id is null or the tenant is gone). */
      tenantName: string | null;
      applicationId: string | null;
      /** Resolved application name (null if the id is null or app is gone). */
      applicationName: string | null;
      /** Resolved application slug (null if the id is null or app is gone). */
      applicationSlug: string | null;
      ip: string | null;
      userAgent: string | null;
      metadata: Record<string, unknown>;
      createdAt: string;
    }>
  > {
    const limit = clampLimit(query.limit, 100);
    const offset = clampOffset(query.offset);
    const q = query.q?.trim();
    const where = {
      ...(query.actorType ? { actorType: query.actorType } : {}),
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.applicationId ? { applicationId: query.applicationId } : {}),
      ...(query.ip ? { ip: query.ip } : {}),
      // `type` accepts a `*` wildcard suffix or `*foo*` substring shorthand;
      // anything without `*` is exact.
      ...(query.type
        ? query.type.startsWith('*') && query.type.endsWith('*')
          ? { type: { contains: query.type.slice(1, -1) } }
          : query.type.endsWith('*')
            ? { type: { startsWith: query.type.slice(0, -1) } }
            : { type: query.type }
        : {}),
      ...(q
        ? {
            OR: [
              { id: q },
              { actorId: q },
              { type: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.securityEvent.count({ where }),
      prisma.securityEvent.findMany({
        where,
        orderBy: { createdAt: query.order ?? 'desc' },
        skip: offset,
        take: limit,
      }),
    ]);

    // Resolve the raw tenant/application cuids to human names in one round-trip
    // each, so the audit UI renders names instead of opaque ids.
    const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter((x): x is string => !!x))];
    const appIds = [...new Set(rows.map((r) => r.applicationId).filter((x): x is string => !!x))];
    const [tenants, apps] = await Promise.all([
      tenantIds.length
        ? prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      appIds.length
        ? prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true, name: true, slug: true } })
        : Promise.resolve([]),
    ]);
    const tenantById = new Map(tenants.map((t) => [t.id, t]));
    const appById = new Map(apps.map((a) => [a.id, a]));

    const items = rows.map((r) => {
      const app = r.applicationId ? appById.get(r.applicationId) : undefined;
      return {
        id: r.id,
        type: r.type,
        actorType: r.actorType,
        actorId: r.actorId,
        tenantId: r.tenantId,
        tenantName: r.tenantId ? tenantById.get(r.tenantId)?.name ?? null : null,
        applicationId: r.applicationId,
        applicationName: app?.name ?? null,
        applicationSlug: app?.slug ?? null,
        ip: r.ip,
        userAgent: r.userAgent,
        metadata: r.metadata as Record<string, unknown>,
        createdAt: r.createdAt.toISOString(),
      };
    });
    return paged(items, total, limit, offset);
  },

  async apiRequests(
    query: ListQuery<'createdAt' | 'durationMs' | 'statusCode'> & {
      method?: string | undefined;
      pathContains?: string | undefined;
      statusGte?: number | undefined;
      statusLt?: number | undefined;
      applicationId?: string | undefined;
      tenantId?: string | undefined;
      operatorUserId?: string | undefined;
      ip?: string | undefined;
    } = {},
  ): Promise<
    Page<{
      id: string;
      method: string;
      routePath: string;
      statusCode: number;
      durationMs: number;
      applicationId: string | null;
      tenantId: string | null;
      operatorUserId: string | null;
      ip: string | null;
      createdAt: string;
    }>
  > {
    const limit = clampLimit(query.limit, 100);
    const offset = clampOffset(query.offset);
    const where = {
      ...(query.method ? { method: query.method.toUpperCase() } : {}),
      ...(query.pathContains ? { routePath: { contains: query.pathContains } } : {}),
      ...(query.statusGte !== undefined || query.statusLt !== undefined
        ? {
            statusCode: {
              ...(query.statusGte !== undefined ? { gte: query.statusGte } : {}),
              ...(query.statusLt !== undefined ? { lt: query.statusLt } : {}),
            },
          }
        : {}),
      ...(query.applicationId ? { applicationId: query.applicationId } : {}),
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.operatorUserId ? { operatorUserId: query.operatorUserId } : {}),
      ...(query.ip ? { ip: query.ip } : {}),
    };
    const orderBy =
      query.sort === 'durationMs'
        ? { durationMs: query.order ?? 'desc' }
        : query.sort === 'statusCode'
          ? { statusCode: query.order ?? 'desc' }
          : { createdAt: query.order ?? 'desc' };
    const [total, rows] = await Promise.all([
      prisma.apiRequestLog.count({ where }),
      prisma.apiRequestLog.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
      }),
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      method: r.method,
      routePath: r.routePath,
      statusCode: r.statusCode,
      durationMs: r.durationMs,
      applicationId: r.applicationId,
      tenantId: r.tenantId,
      operatorUserId: r.operatorUserId,
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
    }));
    return paged(items, total, limit, offset);
  },

  async payments(
    query: ListQuery<'createdAt' | 'amount'> & {
      status?: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | undefined;
      applicationId?: string | undefined;
    } = {},
  ): Promise<
    Page<{
      id: string;
      applicationId: string;
      applicationSlug: string;
      endUserId: string | null;
      amount: number;
      currency: string;
      status: string;
      createdAt: string;
    }>
  > {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const q = query.q?.trim();
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.applicationId ? { applicationId: query.applicationId } : {}),
      ...(q
        ? {
            OR: [
              { id: q },
              { providerPaymentId: q },
              { endUserId: q },
            ],
          }
        : {}),
    };
    const orderBy =
      query.sort === 'amount'
        ? { amount: query.order ?? 'desc' }
        : { createdAt: query.order ?? 'desc' };
    const [total, rows] = await Promise.all([
      prisma.payment.count({ where }),
      prisma.payment.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
        include: { application: { select: { slug: true } } },
      }),
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      applicationId: r.applicationId,
      applicationSlug: r.application.slug,
      endUserId: r.endUserId,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
    return paged(items, total, limit, offset);
  },

  async subscriptions(
    query: ListQuery<'createdAt'> & {
      status?: 'PENDING' | 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED' | undefined;
      applicationId?: string | undefined;
    } = {},
  ): Promise<
    Page<{
      id: string;
      applicationId: string;
      applicationSlug: string;
      endUserId: string;
      planSlug: string;
      planName: string;
      status: string;
      currency: string;
      amount: number;
      interval: string;
      createdAt: string;
      currentPeriodEnd: string | null;
    }>
  > {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const q = query.q?.trim();
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.applicationId ? { applicationId: query.applicationId } : {}),
      ...(q ? { OR: [{ id: q }, { endUserId: q }, { providerSubId: q }] } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.subscription.count({ where }),
      prisma.subscription.findMany({
        where,
        orderBy: { createdAt: query.order ?? 'desc' },
        skip: offset,
        take: limit,
        include: {
          application: { select: { slug: true } },
          plan: { select: { slug: true, name: true, amount: true, currency: true, interval: true } },
        },
      }),
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      applicationId: r.applicationId,
      applicationSlug: r.application.slug,
      endUserId: r.endUserId,
      planSlug: r.plan.slug,
      planName: r.plan.name,
      status: r.status,
      currency: r.plan.currency,
      amount: r.plan.amount,
      interval: r.plan.interval,
      createdAt: r.createdAt.toISOString(),
      currentPeriodEnd: r.currentPeriodEnd?.toISOString() ?? null,
    }));
    return paged(items, total, limit, offset);
  },

  async webhookEvents(
    query: ListQuery<'receivedAt'> & {
      provider?: string | undefined;
      applicationId?: string | undefined;
      onlyFailed?: boolean | undefined;
    } = {},
  ): Promise<
    Page<{
      id: string;
      applicationId: string;
      applicationSlug: string;
      provider: string;
      eventType: string;
      receivedAt: string;
      processedAt: string | null;
      processingError: string | null;
    }>
  > {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const where = {
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.applicationId ? { applicationId: query.applicationId } : {}),
      ...(query.onlyFailed ? { processingError: { not: null } } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.webhookEvent.count({ where }),
      prisma.webhookEvent.findMany({
        where,
        orderBy: { receivedAt: query.order ?? 'desc' },
        skip: offset,
        take: limit,
        include: { application: { select: { slug: true } } },
      }),
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      applicationId: r.applicationId,
      applicationSlug: r.application.slug,
      provider: r.provider,
      eventType: r.eventType,
      receivedAt: r.receivedAt.toISOString(),
      processedAt: r.processedAt?.toISOString() ?? null,
      processingError: r.processingError,
    }));
    return paged(items, total, limit, offset);
  },

  async webhookDeliveries(
    query: ListQuery<'createdAt'> & {
      status?: 'PENDING' | 'SUCCEEDED' | 'FAILED' | undefined;
      applicationId?: string | undefined;
      endpointId?: string | undefined;
    } = {},
  ): Promise<
    Page<{
      id: string;
      endpointId: string;
      applicationId: string;
      applicationSlug: string;
      eventType: string;
      status: string;
      attempts: number;
      responseStatus: number | null;
      createdAt: string;
    }>
  > {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.applicationId ? { applicationId: query.applicationId } : {}),
      ...(query.endpointId ? { endpointId: query.endpointId } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.webhookDelivery.count({ where }),
      prisma.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: query.order ?? 'desc' },
        skip: offset,
        take: limit,
        include: { endpoint: { include: { application: { select: { slug: true } } } } },
      }),
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      endpointId: r.endpointId,
      applicationId: r.applicationId,
      applicationSlug: r.endpoint.application.slug,
      eventType: r.eventType,
      status: r.status,
      attempts: r.attempts,
      responseStatus: r.responseStatus,
      createdAt: r.createdAt.toISOString(),
    }));
    return paged(items, total, limit, offset);
  },

  /**
   * Outstanding prepaid credits, `SUM(CreditBalance.balance)`. Credits are
   * unit-less in Rekey's model (each Application decides what a credit
   * means in its own product), so this is a unit-less count, NOT cents.
   * Operator reads this as "how many prepaid units have been bought but
   * not yet consumed across all applications." Per-app breakdown returns
   * the top N by balance.
   */
  async creditLiability(): Promise<{
    totalOutstanding: number;
    perApp: Array<{ applicationId: string; applicationSlug: string; applicationName: string; outstanding: number }>;
  }> {
    const [agg, grouped] = await Promise.all([
      prisma.creditBalance.aggregate({ _sum: { balance: true } }),
      prisma.creditBalance.groupBy({
        by: ['applicationId'],
        _sum: { balance: true },
        orderBy: { _sum: { balance: 'desc' } },
        take: 20,
      }),
    ]);

    const appIds = grouped.map((g) => g.applicationId);
    const apps =
      appIds.length === 0
        ? []
        : await prisma.application.findMany({
            where: { id: { in: appIds } },
            select: { id: true, slug: true, name: true },
          });
    const appById = new Map(apps.map((a) => [a.id, a]));
    return {
      totalOutstanding: agg._sum.balance ?? 0,
      perApp: grouped.map((g) => {
        const a = appById.get(g.applicationId);
        return {
          applicationId: g.applicationId,
          applicationSlug: a?.slug ?? '?',
          applicationName: a?.name ?? '(deleted)',
          outstanding: g._sum.balance ?? 0,
        };
      }),
    };
  },

  /**
   * Accounts currently inside the failed-sign-in lockout window, **end-users
   * AND operators**.
   *
   * The operator half was missing, and its absence was the sharper problem of
   * the two. A locked-out workspace OWNER, the account that owns every
   * Application, API key and billing credential in their workspace, appeared
   * in no operator- or admin-facing surface at all: this endpoint read only
   * `bf:lock:eu:login:*`, and the workspace security log they might otherwise
   * have been visible in is behind the sign-in they cannot complete. The
   * super-admin surface is the one place reachable when the owner is locked out
   * of their own.
   *
   * `operators` therefore sits alongside `accounts` rather than being folded
   * into it: the two carry different identities (an operator lock has no
   * Application) and consumers filter on that. `accounts` keeps its exact
   * previous shape and meaning.
   *
   * Sourced from the Redis brute-force limiter (`lib/brute-force.ts`), NOT the
   * `EndUser.{lockedUntil,failedSignInAttempts}` columns, which are gone (they
   * outlived their writer and were dropped on 2026-07-30). We `SCAN` the
   * `bf:lock:eu:login:*` keys (each encodes applicationId + email), resolve the
   * remaining TTL as `lockedUntil`, and join back to `EndUser` for the id +
   * application slug. `failedAttempts` reports the policy threshold: a lock is
   * only set once the counter reaches it, so it's the floor on failures that
   * tripped the lock (the counter itself is cleared at lock time).
   *
   * Fail-open: with no Redis (tests / outage) this returns an empty list.
   */
  async lockedAccounts(query: ListQuery<'lockedUntil' | 'failedSignInAttempts'> = {}): Promise<{
    total: number;
    accounts: Array<{
      id: string;
      applicationId: string;
      applicationSlug: string;
      email: string;
      failedAttempts: number;
      lockedUntil: string;
    }>;
    /** Count of locked OPERATOR accounts (`bf:lock:op:login:*`). */
    operatorsTotal: number;
    operators: Array<{
      /** TenantUser id, or a synthetic `op:<email>` when the row is gone. */
      id: string;
      email: string;
      /** Workspaces this operator belongs to, who else can still get in. */
      workspaces: Array<{ tenantId: string; tenantName: string; role: string }>;
      failedAttempts: number;
      lockedUntil: string;
    }>;
  }> {
    const limit = clampLimit(query.limit, 50);
    const now = new Date();
    const [{ total, locks }, operators] = await Promise.all([
      scanActiveLoginLocks(limit),
      this.lockedOperators(limit, now, query.order ?? 'desc'),
    ]);
    if (locks.length === 0) return { total, accounts: [], ...operators };

    // Resolve each (applicationId, email) to its EndUser for id + slug. The
    // lock survives a few ms longer than the row in the (rare) tombstone race,
    // so tolerate a missing row by falling back to a synthetic key.
    const accounts = await Promise.all(
      locks.map(async (lock) => {
        const user = await prisma.endUser.findUnique({
          where: { applicationId_email: { applicationId: lock.applicationId, email: lock.email } },
          select: { id: true, application: { select: { slug: true } } },
        });
        return {
          id: user?.id ?? `${lock.applicationId}:${lock.email}`,
          applicationId: lock.applicationId,
          applicationSlug: user?.application.slug ?? '?',
          email: lock.email,
          failedAttempts: LOGIN_POLICY.threshold,
          lockedUntil: new Date(now.getTime() + lock.ttlSec * 1000).toISOString(),
        };
      }),
    );
    // `failedAttempts` is uniform now, so only `lockedUntil` is a meaningful
    // sort key; default newest-lock (longest remaining TTL) first.
    return {
      total,
      accounts: sortByField(accounts, 'lockedUntil', query.order ?? 'desc'),
      ...operators,
    };
  },

  /**
   * The operator half of `lockedAccounts`. Split out only to keep that method
   * readable, it has no other caller.
   *
   * `workspaces` is the actionable part: it names the workspaces the locked
   * operator belongs to, so the deployment administrator can tell at a glance
   * whether anyone else can still administer them, or whether this lock has
   * shut a workspace down entirely.
   */
  async lockedOperators(
    limit: number,
    now: Date,
    order: 'asc' | 'desc',
  ): Promise<{
    operatorsTotal: number;
    operators: Array<{
      id: string;
      email: string;
      workspaces: Array<{ tenantId: string; tenantName: string; role: string }>;
      failedAttempts: number;
      lockedUntil: string;
    }>;
  }> {
    const { total, locks } = await scanActiveOperatorLoginLocks(limit);
    if (locks.length === 0) return { operatorsTotal: total, operators: [] };
    const operators = await Promise.all(
      locks.map(async (lock) => {
        const user = await prisma.tenantUser.findUnique({
          where: { email: lock.email },
          select: {
            id: true,
            memberships: {
              select: { tenantId: true, role: true, tenant: { select: { name: true } } },
              orderBy: { createdAt: 'asc' },
            },
          },
        });
        return {
          // Same tombstone tolerance as the end-user branch: the lock key
          // outlives a deleted row by up to its TTL.
          id: user?.id ?? `op:${lock.email}`,
          email: lock.email,
          workspaces: (user?.memberships ?? []).map((m) => ({
            tenantId: m.tenantId,
            tenantName: m.tenant.name,
            role: m.role as string,
          })),
          failedAttempts: LOGIN_POLICY.threshold,
          lockedUntil: new Date(now.getTime() + lock.ttlSec * 1000).toISOString(),
        };
      }),
    );
    return { operatorsTotal: total, operators: sortByField(operators, 'lockedUntil', order) };
  },

  /**
   * Email-deliverability rollup from `EmailLog`. Four statuses are written:
   * three at the transport boundary (`sent | error | no_transport`) and
   * `suppressed` at the gate before it, for a send an Application's own
   * configuration stopped. The dashboard surfaces raw counts + a success ratio
   * across 24h / 7d. `topErrorApps` lists the worst offenders so the operator
   * knows where to look first, and deliberately filters on `error` alone, so
   * an Application that has switched an event off does not appear as a
   * deliverability problem.
   */
  async emailDeliverability(): Promise<{
    last24h: { sent: number; error: number; noTransport: number; suppressed: number; total: number };
    last7d: { sent: number; error: number; noTransport: number; suppressed: number; total: number };
    topErrorApps: Array<{ applicationId: string; applicationSlug: string; errors: number }>;
  }> {
    const since24h = new Date(Date.now() - DAY_MS);
    const since7d = new Date(Date.now() - 7 * DAY_MS);
    const [grouped24h, grouped7d, errorByApp] = await Promise.all([
      prisma.emailLog.groupBy({ by: ['status'], where: { createdAt: { gte: since24h } }, _count: { _all: true } }),
      prisma.emailLog.groupBy({ by: ['status'], where: { createdAt: { gte: since7d } }, _count: { _all: true } }),
      prisma.emailLog.groupBy({
        by: ['applicationId'],
        where: { createdAt: { gte: since7d }, status: 'error', applicationId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { applicationId: 'desc' } },
        take: 5,
      }),
    ]);
    function rollup(rows: Array<{ status: string; _count: { _all: number } }>): {
      sent: number;
      error: number;
      noTransport: number;
      suppressed: number;
      total: number;
    } {
      const m = Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<string, number>;
      const sent = m.sent ?? 0;
      const error = m.error ?? 0;
      const noTransport = m.no_transport ?? 0;
      const suppressed = m.suppressed ?? 0;
      return { sent, error, noTransport, suppressed, total: sent + error + noTransport + suppressed };
    }

    const appIds = errorByApp.map((r) => r.applicationId).filter((id): id is string => !!id);
    const apps =
      appIds.length === 0
        ? []
        : await prisma.application.findMany({
            where: { id: { in: appIds } },
            select: { id: true, slug: true },
          });
    const appById = new Map(apps.map((a) => [a.id, a]));
    return {
      last24h: rollup(grouped24h),
      last7d: rollup(grouped7d),
      topErrorApps: errorByApp.map((r) => ({
        applicationId: r.applicationId ?? '',
        applicationSlug: appById.get(r.applicationId ?? '')?.slug ?? '?',
        errors: r._count._all,
      })),
    };
  },

  /**
   * Aggregate outbound webhook deliveries by endpoint over the last 24h.
   * Surfaces persistent-failure endpoints that the per-row delivery list
   * makes hard to spot. Returns top N endpoints sorted by failure count.
   */
  async webhookEndpointHealth(): Promise<
    Array<{
      endpointId: string;
      url: string;
      applicationId: string;
      applicationSlug: string;
      succeeded: number;
      failed: number;
      pending: number;
      successRate: number | null;
    }>
  > {
    const since24h = new Date(Date.now() - DAY_MS);
    const grouped = await prisma.webhookDelivery.groupBy({
      by: ['endpointId', 'status'],
      where: { createdAt: { gte: since24h } },
      _count: { _all: true },
    });
    // Pivot status into per-endpoint counters.
    const byEndpoint = new Map<string, { succeeded: number; failed: number; pending: number }>();
    for (const g of grouped) {
      const e = byEndpoint.get(g.endpointId) ?? { succeeded: 0, failed: 0, pending: 0 };
      if (g.status === 'SUCCEEDED') e.succeeded = g._count._all;
      else if (g.status === 'FAILED') e.failed = g._count._all;
      else if (g.status === 'PENDING') e.pending = g._count._all;
      byEndpoint.set(g.endpointId, e);
    }
    const endpointIds = [...byEndpoint.keys()];
    if (endpointIds.length === 0) return [];
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { id: { in: endpointIds } },
      include: { application: { select: { slug: true } } },
    });
    const out = endpoints.map((e) => {
      const counts = byEndpoint.get(e.id) ?? { succeeded: 0, failed: 0, pending: 0 };
      const total = counts.succeeded + counts.failed + counts.pending;
      return {
        endpointId: e.id,
        url: e.url,
        applicationId: e.applicationId,
        applicationSlug: e.application.slug,
        succeeded: counts.succeeded,
        failed: counts.failed,
        pending: counts.pending,
        successRate: total === 0 ? null : counts.succeeded / total,
      };
    });
    // Sort: highest failure count first so retry-storm endpoints surface.
    return sortByField(out, 'failed', 'desc').slice(0, 20);
  },

  /**
   * Payment health bucketed by application over the last 30 days. Surfaces
   * apps whose Stripe/PayPal/Razorpay integration is failing more than
   * others. Returns top 20 apps sorted by failed count.
   */
  async paymentsByApp(): Promise<
    Array<{
      applicationId: string;
      applicationSlug: string;
      applicationName: string;
      succeeded: number;
      failed: number;
      pending: number;
      refunded: number;
      successRate: number | null;
      volumeCents: number;
    }>
  > {
    const since30d = new Date(Date.now() - 30 * DAY_MS);
    const [groupedStatus, groupedVolume] = await Promise.all([
      prisma.payment.groupBy({
        by: ['applicationId', 'status'],
        where: { createdAt: { gte: since30d } },
        _count: { _all: true },
      }),
      prisma.payment.groupBy({
        by: ['applicationId'],
        where: { createdAt: { gte: since30d }, status: 'SUCCEEDED' },
        _sum: { amount: true },
      }),
    ]);
    const volumeByApp = new Map(groupedVolume.map((g) => [g.applicationId, g._sum.amount ?? 0]));
    const byApp = new Map<
      string,
      { succeeded: number; failed: number; pending: number; refunded: number }
    >();
    for (const g of groupedStatus) {
      const a = byApp.get(g.applicationId) ?? { succeeded: 0, failed: 0, pending: 0, refunded: 0 };
      if (g.status === 'SUCCEEDED') a.succeeded = g._count._all;
      else if (g.status === 'FAILED') a.failed = g._count._all;
      else if (g.status === 'PENDING') a.pending = g._count._all;
      else if (g.status === 'REFUNDED') a.refunded = g._count._all;
      byApp.set(g.applicationId, a);
    }
    const appIds = [...byApp.keys()];
    if (appIds.length === 0) return [];
    const apps = await prisma.application.findMany({
      where: { id: { in: appIds } },
      select: { id: true, slug: true, name: true },
    });
    const appById = new Map(apps.map((a) => [a.id, a]));
    const out = appIds.map((appId) => {
      const a = byApp.get(appId)!;
      const denom = a.succeeded + a.failed;
      return {
        applicationId: appId,
        applicationSlug: appById.get(appId)?.slug ?? '?',
        applicationName: appById.get(appId)?.name ?? '(deleted)',
        succeeded: a.succeeded,
        failed: a.failed,
        pending: a.pending,
        refunded: a.refunded,
        successRate: denom === 0 ? null : a.succeeded / denom,
        volumeCents: volumeByApp.get(appId) ?? 0,
      };
    });
    return sortByField(out, 'failed', 'desc').slice(0, 20);
  },
};
