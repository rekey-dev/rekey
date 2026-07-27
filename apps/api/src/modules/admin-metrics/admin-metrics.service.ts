/**
 * Super-admin metrics service.
 *
 * Pure READ aggregations across the whole deployment for the operator
 * dashboard at admin.relipay.dev. Every method is a `findMany`/`count`/
 * `groupBy` over Prisma — no writes, no caching. The dashboard runs at low
 * cadence (operator-driven page loads), so we avoid materialised views and
 * compute on demand.
 *
 * Performance shape: every list endpoint takes a small `limit` (default 50,
 * max 200). The overview rolls up counts in parallel with `Promise.all`.
 */

import { prisma } from '../../lib/prisma.js';
import { getRedis } from '../../lib/redis.js';
import { scanActiveLoginLocks, LOGIN_POLICY } from '../../lib/brute-force.js';

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
 * One page of a list endpoint. `total` is the full count of matching rows
 * (independent of limit/offset) so the UI can render "X–Y of Z" + page nav.
 */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Upper bound on rows scanned for a COMPUTED-sort page (MRR, end-user count,
 * last-activity — values that aren't DB columns, so we sort in JS). The window
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
  // `| undefined` on each — Zod's `.optional()` produces `T | undefined` which
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
   * NOT the dead `EndUser.lockedUntil` column — see `scanActiveLoginLocks`.
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
  // Cap the read at a sane page size — a deployment with MRR_READ_CAP+ active
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

export const adminMetricsService = {
  async overview(): Promise<OverviewMetrics> {
    const now = new Date();
    const since24h = new Date(now.getTime() - DAY_MS);
    const since7d = new Date(now.getTime() - 7 * DAY_MS);
    const since30d = new Date(now.getTime() - 30 * DAY_MS);

    const [
      tenantsTotal,
      tenantsNew30d,
      appsTotal,
      appsNew30d,
      endUsersTotal,
      endUsersVerified,
      endUsersNew24h,
      endUsersNew7d,
      endUsersNew30d,
      orgsTotal,
      orgsNew30d,
      subsGrouped,
      paymentsLifetime,
      paymentsLast30d,
      paymentsSucceeded24h,
      paymentsFailed24h,
      mrrCents,
      webhookEvents24h,
      webhookDeliveries24h,
      webhookDeliveriesFailed24h,
      requestsLast24h,
      requests4xx24h,
      requests5xx24h,
      requestsAvgDuration,
      tenantUsersTotal,
      tenantUsersActive30d,
      lockedAccountsCount,
      outstandingCreditsAgg,
      emailGrouped24h,
    ] = await Promise.all([
      prisma.tenant.count(),
      prisma.tenant.count({ where: { createdAt: { gte: since30d } } }),
      prisma.application.count(),
      prisma.application.count({ where: { createdAt: { gte: since30d } } }),
      prisma.endUser.count(),
      prisma.endUser.count({ where: { emailVerified: true } }),
      prisma.endUser.count({ where: { createdAt: { gte: since24h } } }),
      prisma.endUser.count({ where: { createdAt: { gte: since7d } } }),
      prisma.endUser.count({ where: { createdAt: { gte: since30d } } }),
      prisma.organization.count(),
      prisma.organization.count({ where: { createdAt: { gte: since30d } } }),
      prisma.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.payment.aggregate({ _count: { _all: true }, _sum: { amount: true }, where: { status: 'SUCCEEDED' } }),
      prisma.payment.aggregate({ _count: { _all: true }, _sum: { amount: true }, where: { status: 'SUCCEEDED', createdAt: { gte: since30d } } }),
      prisma.payment.count({ where: { status: 'SUCCEEDED', createdAt: { gte: since24h } } }),
      prisma.payment.count({ where: { status: 'FAILED', createdAt: { gte: since24h } } }),
      computeMrrCents(),
      prisma.webhookEvent.count({ where: { receivedAt: { gte: since24h } } }),
      prisma.webhookDelivery.count({ where: { createdAt: { gte: since24h } } }),
      prisma.webhookDelivery.count({ where: { createdAt: { gte: since24h }, status: 'FAILED' } }),
      prisma.apiRequestLog.count({ where: { createdAt: { gte: since24h } } }),
      prisma.apiRequestLog.count({ where: { createdAt: { gte: since24h }, statusCode: { gte: 400, lt: 500 } } }),
      prisma.apiRequestLog.count({ where: { createdAt: { gte: since24h }, statusCode: { gte: 500 } } }),
      prisma.apiRequestLog.aggregate({ _avg: { durationMs: true }, where: { createdAt: { gte: since24h } } }),
      prisma.tenantUser.count(),
      // "Active" operator = had a refresh token created in the last 30 days.
      // Equivalent of a sign-in event since refresh rotation also writes here.
      prisma.tenantUser.count({
        where: { refreshTokens: { some: { createdAt: { gte: since30d } } } },
      }),
      // End-user lockouts in effect right now (failed sign-in protection).
      // Lockout lives in the Redis brute-force limiter, not a DB column —
      // enumerate the `bf:lock:eu:login:*` keys. limit:0 → count only.
      scanActiveLoginLocks(0).then((r) => r.total),
      prisma.creditBalance.aggregate({ _sum: { balance: true } }),
      prisma.emailLog.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since24h } },
        _count: { _all: true },
      }),
    ]);

    // Roll the email grouping into the overview's tiny rollup shape. Full
    // detail lives behind `/api/v1/admin/metrics/email-deliverability`.
    const emailMap = Object.fromEntries(emailGrouped24h.map((r) => [r.status, r._count._all])) as Record<string, number>;
    const emailLast24h = {
      sent: emailMap.sent ?? 0,
      error: emailMap.error ?? 0,
      noTransport: emailMap.no_transport ?? 0,
      total: (emailMap.sent ?? 0) + (emailMap.error ?? 0) + (emailMap.no_transport ?? 0),
    };

    const subsByStatus = Object.fromEntries(subsGrouped.map((g) => [g.status, g._count._all])) as Record<string, number>;

    return {
      tenants: { total: tenantsTotal, newLast30d: tenantsNew30d },
      applications: { total: appsTotal, newLast30d: appsNew30d },
      endUsers: {
        total: endUsersTotal,
        verified: endUsersVerified,
        newLast24h: endUsersNew24h,
        newLast7d: endUsersNew7d,
        newLast30d: endUsersNew30d,
      },
      organizations: { total: orgsTotal, newLast30d: orgsNew30d },
      subscriptions: {
        pending: subsByStatus.PENDING ?? 0,
        active: subsByStatus.ACTIVE ?? 0,
        pastDue: subsByStatus.PAST_DUE ?? 0,
        canceled: subsByStatus.CANCELED ?? 0,
        expired: subsByStatus.EXPIRED ?? 0,
        total: Object.values(subsByStatus).reduce((a, b) => a + b, 0),
      },
      payments: {
        lifetime: { count: paymentsLifetime._count._all, volumeCents: paymentsLifetime._sum.amount ?? 0 },
        last30d: { count: paymentsLast30d._count._all, volumeCents: paymentsLast30d._sum.amount ?? 0 },
        succeededLast24h: paymentsSucceeded24h,
        failedLast24h: paymentsFailed24h,
      },
      mrrCents: mrrCents.totalCents,
      mrrCapped: mrrCents.capped,
      webhooks: {
        eventsLast24h: webhookEvents24h,
        deliveriesLast24h: webhookDeliveries24h,
        deliveriesFailedLast24h: webhookDeliveriesFailed24h,
      },
      apiRequests: {
        last24h: requestsLast24h,
        errors4xxLast24h: requests4xx24h,
        errors5xxLast24h: requests5xx24h,
        avgDurationMs: Math.round(requestsAvgDuration._avg.durationMs ?? 0),
      },
      tenantUsers: { total: tenantUsersTotal, activeLast30d: tenantUsersActive30d },
      lockedAccountsCount,
      outstandingCredits: outstandingCreditsAgg._sum.balance ?? 0,
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
    let dbStatus: 'up' | 'down' = 'down';
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

    // Oldest inbound webhook still unprocessed — surfaces stuck queues.
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
      // RefreshToken.createdAt is the closest proxy for "active end-user" — a
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
      /** True when the per-tenant MRR sum saturated MRR_READ_CAP (lower bound). */
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
    // lastActivityAt) we need to enrich more than `limit` rows before sorting
    // — otherwise top-N by MRR could be wrong if the top earners are older.
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

    // For each tenant fan out the per-app aggregates. The list is bounded
    // (default 50) so the parallel fan-out is fine.
    const enriched = await Promise.all(
      tenants.map(async (t) => {
        const appIds = t.applications.map((a) => a.id);
        if (appIds.length === 0) {
          return {
            id: t.id,
            name: t.name,
            ownerEmail: t.ownerEmail,
            applicationCount: 0,
            endUserCount: 0,
            organizationCount: 0,
            activeSubscriptions: 0,
            mrrCents: 0,
            mrrCapped: false,
            createdAt: t.createdAt.toISOString(),
            lastActivityAt: null as string | null,
          };
        }
        const [endUserCount, orgCount, activeSubs, lastReq, activeSubPlans] = await Promise.all([
          prisma.endUser.count({ where: { applicationId: { in: appIds } } }),
          prisma.organization.count({ where: { applicationId: { in: appIds } } }),
          prisma.subscription.count({ where: { applicationId: { in: appIds }, status: 'ACTIVE' } }),
          prisma.apiRequestLog.findFirst({
            where: { applicationId: { in: appIds } },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          }),
          // Bounded read for per-tenant MRR. If a single tenant ever crosses
          // this cap, the tenant row's MRR is a lower bound — surfaced via
          // `mrrCapped` so the UI flags it instead of silently undercounting.
          prisma.subscription.findMany({
            where: { applicationId: { in: appIds }, status: 'ACTIVE' },
            select: { plan: { select: { amount: true, interval: true } } },
            take: MRR_READ_CAP,
          }),
        ]);
        let mrr = 0;
        for (const s of activeSubPlans) {
          if (!s.plan) continue;
          mrr += s.plan.interval === 'YEAR' ? Math.floor(s.plan.amount / 12) : s.plan.amount;
        }
        const mrrCapped = activeSubPlans.length === MRR_READ_CAP;
        return {
          id: t.id,
          name: t.name,
          ownerEmail: t.ownerEmail,
          applicationCount: appIds.length,
          endUserCount,
          organizationCount: orgCount,
          activeSubscriptions: activeSubs,
          mrrCents: mrr,
          mrrCapped,
          createdAt: t.createdAt.toISOString(),
          lastActivityAt: lastReq?.createdAt.toISOString() ?? null,
        };
      }),
    );

    // Post-aggregate sort for computed fields, then slice out the requested
    // page window. DB-column sort already returned exactly the page.
    const items =
      isComputedSort && query.sort
        ? sortByField(enriched, query.sort as keyof (typeof enriched)[number], query.order ?? 'desc').slice(
            offset,
            offset + limit,
          )
        : enriched;
    return { items, total, limit, offset };
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
    const enriched = await Promise.all(
      apps.map(async (a) => {
        const [endUserCount, activeSubs, requests24h] = await Promise.all([
          prisma.endUser.count({ where: { applicationId: a.id } }),
          prisma.subscription.count({ where: { applicationId: a.id, status: 'ACTIVE' } }),
          prisma.apiRequestLog.count({ where: { applicationId: a.id, createdAt: { gte: since24h } } }),
        ]);
        return {
          id: a.id,
          tenantId: a.tenantId,
          tenantName: a.tenant.name,
          name: a.name,
          slug: a.slug,
          endUserCount,
          activeSubscriptions: activeSubs,
          apiRequestsLast24h: requests24h,
          createdAt: a.createdAt.toISOString(),
        };
      }),
    );
    const items =
      isComputedSort && query.sort
        ? sortByField(enriched, query.sort as keyof (typeof enriched)[number], query.order ?? 'desc').slice(
            offset,
            offset + limit,
          )
        : enriched;
    return { items, total, limit, offset };
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
    return { items, total, limit, offset };
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
    return { items, total, limit, offset };
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
    return { items, total, limit, offset };
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
    return { items, total, limit, offset };
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
    return { items, total, limit, offset };
  },

  async subscriptions(
    query: ListQuery<'createdAt'> & {
      status?: 'PENDING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED' | undefined;
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
    return { items, total, limit, offset };
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
    return { items, total, limit, offset };
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
    return { items, total, limit, offset };
  },

  /**
   * Outstanding prepaid credits — `SUM(CreditBalance.balance)`. Credits are
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
   * End-user accounts currently inside the failed-sign-in lockout window.
   *
   * Sourced from the Redis brute-force limiter (`lib/brute-force.ts`), NOT the
   * dead `EndUser.{lockedUntil,failedSignInAttempts}` columns — lockout moved
   * to Redis and nothing writes those columns anymore. We `SCAN` the
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
  }> {
    const limit = clampLimit(query.limit, 50);
    const now = new Date();
    const { total, locks } = await scanActiveLoginLocks(limit);
    if (locks.length === 0) return { total, accounts: [] };

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
    return { total, accounts: sortByField(accounts, 'lockedUntil', query.order ?? 'desc') };
  },

  /**
   * Email-deliverability rollup from `EmailLog`. Three statuses are written
   * at the transport boundary (`sent | error | no_transport`), so the
   * dashboard can surface raw counts + a success ratio across 24h / 7d.
   * `topErrorApps` lists the worst offenders so the operator knows where to
   * look first.
   */
  async emailDeliverability(): Promise<{
    last24h: { sent: number; error: number; noTransport: number; total: number };
    last7d: { sent: number; error: number; noTransport: number; total: number };
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
      total: number;
    } {
      const m = Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<string, number>;
      const sent = m.sent ?? 0;
      const error = m.error ?? 0;
      const noTransport = m.no_transport ?? 0;
      return { sent, error, noTransport, total: sent + error + noTransport };
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
