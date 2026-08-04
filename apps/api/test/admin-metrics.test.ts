/**
 * Super-admin metrics — `/api/v1/admin/metrics/*`.
 *
 * ~1,850 LOC of aggregation that had no test at all. It is the operator's only
 * view of a running deployment: if `overview` throws on an empty database, or
 * a list endpoint quietly stops honouring `offset`, the dashboard is wrong and
 * nothing else notices.
 *
 * Three contracts are pinned here:
 *   1. Every registered endpoint answers 200 for SUPER_ADMIN_KEY and 401
 *      without it. Driven from the live route table, so a new endpoint that
 *      forgets the `requireSuperAdmin` hook fails this file.
 *   2. The list endpoints return the documented `Page<T>`
 *      (`{ items, page: { total, limit, offset, hasMore } }`) and `offset`
 *      really skips. These endpoints used to flatten the pagination one level
 *      up (`{ items, total, limit, offset }`), which disagreed with the
 *      published OpenAPI document on every one of them.
 *   3. The rollups report the rows that exist, not zeros.
 *
 * `services.redis` is asserted as `not_configured` on purpose — `lib/redis.ts`
 * returns null under NODE_ENV=test, so this suite can never exercise the
 * Redis-up branch. Pinning the test-mode value at least makes the gap visible
 * rather than implicit.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { flushApiRequestLogs } from '../src/lib/request-log.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const BASE = '/api/v1/admin/metrics';

/**
 * Endpoints that are NOT paginated: a bare object rollup, or (for
 * `webhook-endpoint-health` and `payments-by-app`) a bare array, because their
 * result set is bounded by the deployment rather than by usage.
 */
const ROLLUP_ENDPOINTS = [
  'overview',
  'services',
  'retention',
  'credit-liability',
  'locked-accounts',
  'email-deliverability',
  'webhook-endpoint-health',
  'payments-by-app',
] as const;

/** Endpoints returning the paginated `Page<T>` envelope. */
const PAGED_ENDPOINTS = [
  'tenants',
  'applications',
  'end-users',
  'tenant-users',
  'security-events',
  'api-requests',
  'payments',
  'subscriptions',
  'webhook-events',
  'webhook-deliveries',
] as const;

const ALL_ENDPOINTS = [...ROLLUP_ENDPOINTS, ...PAGED_ENDPOINTS];

interface Page {
  items: unknown[];
  page: { total: number; limit: number; offset: number; hasMore: boolean };
}

describe('admin metrics', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function get(path: string, key: string | null = ADMIN_KEY): ReturnType<typeof app.inject> {
    return app.inject({
      method: 'GET',
      url: `${BASE}/${path}`,
      ...(key === null ? {} : { headers: { authorization: `Bearer ${key}` } }),
    });
  }

  async function createTenant(name: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name, ownerEmail: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com` },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { id: string }).id;
  }

  async function createApplication(tenantId: string, slug: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { tenantId, name: slug, slug },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { id: string }).id;
  }

  async function liveKeyFor(applicationId: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/api-keys`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name: 'k', mode: 'live' },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { rawKey: string }).rawKey;
  }

  // ---------- auth + reachability, one case per endpoint ----------

  it.each(ALL_ENDPOINTS)('GET /%s answers the super-admin and refuses everyone else', async (path) => {
    const ok = await get(path);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().success).toBe(true);
    expect(ok.json().data).toBeDefined();

    const noKey = await get(path, null);
    expect(noKey.statusCode).toBe(401);
    expect(noKey.json().error.code).toBe('ADMIN_AUTH_MISSING');

    const wrongKey = await get(path, 'not-the-admin-key-not-the-admin-key-not-the');
    expect(wrongKey.statusCode).toBe(401);
    expect(wrongKey.json().error.code).toBe('ADMIN_AUTH_INVALID');
  });

  it('the endpoint list above matches the routes the server actually registers', () => {
    const doc = (app as unknown as { swagger: () => { paths: Record<string, unknown> } }).swagger();
    const registered = Object.keys(doc.paths)
      .filter((p) => p.startsWith(`${BASE}/`))
      .map((p) => p.slice(BASE.length + 1))
      .sort();
    expect(
      registered,
      'a metrics endpoint was added or removed — update ROLLUP_ENDPOINTS / PAGED_ENDPOINTS',
    ).toEqual([...ALL_ENDPOINTS].sort());
  });

  // ---------- Page<T> contract ----------

  it.each(PAGED_ENDPOINTS)('GET /%s returns the documented Page envelope', async (path) => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/${path}?limit=7&offset=3`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as Page;
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.page.total).toBe('number');
    // limit/offset are echoed so the caller can build page links without
    // re-deriving what the server clamped to.
    expect(body.page.limit).toBe(7);
    expect(body.page.offset).toBe(3);
    // `hasMore` is derived from the other three, never asserted independently.
    expect(body.page.hasMore).toBe(body.page.offset + body.page.limit < body.page.total);
  });

  it('offset actually skips rows and total counts the whole match set', async () => {
    await createTenant('Alpha');
    await createTenant('Bravo');
    await createTenant('Charlie');

    const first = await get('tenants?limit=2');
    const firstPage = first.json().data as Page & { items: Array<{ id: string }> };
    expect(firstPage.page.total).toBe(3);
    expect(firstPage.page.hasMore).toBe(true);
    expect(firstPage.items).toHaveLength(2);

    const second = await get('tenants?limit=2&offset=2');
    const secondPage = second.json().data as Page & { items: Array<{ id: string }> };
    expect(secondPage.page.total).toBe(3);
    expect(secondPage.page.hasMore).toBe(false);
    expect(secondPage.items).toHaveLength(1);

    // No overlap — the second page is genuinely further down the list.
    const firstIds = firstPage.items.map((t) => t.id);
    expect(firstIds).not.toContain(secondPage.items[0]!.id);
  });

  it('refuses an out-of-range limit rather than serving 500 rows', async () => {
    const res = await get('tenants?limit=500');
    // The invariant: bad query input never yields a page.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().data).toBeUndefined();

    // This used to be 500 INTERNAL_ERROR: these routes declare no Fastify
    // `querystring` schema, so the Zod parse in the handler is the only
    // validator, and `rekeyErrorHandler` had no ZodError branch — so a typo'd
    // query param (`?limit=500`, `?sort=bogus`, `?order=sideways`,
    // `?status=NOPE`) became a server error telling the caller to contact
    // support about their own typo. Fixed in lib/error.ts; the loose assertion
    // above is what let this file survive the fix untouched.
    expect(res.json().error.code).toBe(res.statusCode === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR');
  });

  // ---------- rollup shapes ----------

  it('overview reports the rows that exist, not zeros', async () => {
    const tenantId = await createTenant('Metrics');
    const applicationId = await createApplication(tenantId, `m-app-${Math.random().toString(36).slice(2, 8)}`);
    const key = await liveKeyFor(applicationId);
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${key}` },
      payload: { email: `metrics-${Math.random().toString(36).slice(2, 8)}@example.com`, password: 'pw-one-two-three' },
    });
    expect(signUp.statusCode).toBe(201);

    const res = await get('overview');
    const data = res.json().data as {
      tenants: { total: number; newLast30d: number };
      applications: { total: number };
      endUsers: { total: number; newLast24h: number };
      subscriptions: { total: number };
      mrrCents: number;
      mrrCapped: boolean;
    };
    expect(data.tenants.total).toBe(1);
    expect(data.tenants.newLast30d).toBe(1);
    expect(data.applications.total).toBe(1);
    expect(data.endUsers.total).toBe(1);
    expect(data.endUsers.newLast24h).toBe(1);
    expect(data.subscriptions.total).toBe(0);
    // No active subscriptions → zero MRR, and the read cap was not saturated.
    expect(data.mrrCents).toBe(0);
    expect(data.mrrCapped).toBe(false);
  });

  it('overview survives a completely empty deployment', async () => {
    const res = await get('overview');
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { tenants: { total: number }; endUsers: { total: number } };
    expect(data.tenants.total).toBe(0);
    expect(data.endUsers.total).toBe(0);
  });

  it('services pings the database live; Redis is unconfigured under NODE_ENV=test', async () => {
    const res = await get('services');
    const data = res.json().data as {
      api: { status: string };
      database: { status: string; latencyMs: number | null };
      redis: { status: string };
      webhookDeliverySuccessRate24h: number | null;
    };
    expect(data.api.status).toBe('up');
    expect(data.database.status).toBe('up');
    expect(typeof data.database.latencyMs).toBe('number');
    // lib/redis.ts short-circuits to null under test — the Redis-up branch has
    // no execution coverage anywhere in this suite. See the file header.
    expect(data.redis.status).toBe('not_configured');
    // No deliveries yet → null, not a divide-by-zero NaN.
    expect(data.webhookDeliverySuccessRate24h).toBeNull();
  });

  it('retention buckets the 14-day signup trend by UTC day', async () => {
    const tenantId = await createTenant('Retention');
    const applicationId = await createApplication(tenantId, `r-app-${Math.random().toString(36).slice(2, 8)}`);
    const key = await liveKeyFor(applicationId);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${key}` },
      payload: { email: `ret-${Math.random().toString(36).slice(2, 8)}@example.com`, password: 'pw-one-two-three' },
    });

    const res = await get('retention');
    const data = res.json().data as {
      endUsersActive: { last24h: number; last7d: number; last30d: number };
      operatorsActive: { last24h: number };
      signupTrend14d: Array<{ date: string; count: number }>;
    };
    // Sign-up mints a refresh token, which is the "active end-user" proxy.
    expect(data.endUsersActive.last24h).toBe(1);
    expect(data.endUsersActive.last30d).toBe(1);
    expect(data.signupTrend14d).toHaveLength(1);
    expect(data.signupTrend14d[0]!.count).toBe(1);
    expect(data.signupTrend14d[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('credit-liability sums outstanding prepaid credits and attributes them per app', async () => {
    const tenantId = await createTenant('Liability');
    const slug = `cl-${Math.random().toString(36).slice(2, 8)}`;
    const applicationId = await createApplication(tenantId, slug);
    const key = await liveKeyFor(applicationId);
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${key}` },
      payload: { email: `cl-${Math.random().toString(36).slice(2, 8)}@example.com`, password: 'pw-one-two-three' },
    });
    const endUserId = (signUp.json().data as { endUser: { id: string } }).endUser.id;
    // `subjectKey` is the always-non-null billing-subject key: "u:<id>" for an
    // end-user, "o:<id>" for an organization (see the CreditBalance model).
    await prisma.creditBalance.create({
      data: { applicationId, endUserId, subjectKey: `u:${endUserId}`, balance: 250 },
    });

    const res = await get('credit-liability');
    const data = res.json().data as {
      totalOutstanding: number;
      perApp: Array<{ applicationId: string; applicationSlug: string; outstanding: number }>;
    };
    // This is money the deployment owes in kind — a zero here when balances
    // exist is the bug worth catching, so seed one rather than assert a shape.
    expect(data.totalOutstanding).toBe(250);
    expect(data.perApp).toHaveLength(1);
    expect(data.perApp[0]).toMatchObject({ applicationId, applicationSlug: slug, outstanding: 250 });
  });

  it('locked-accounts fails open to an empty list when Redis is absent', async () => {
    const res = await get('locked-accounts');
    const data = res.json().data as { total: number; accounts: unknown[] };
    expect(data.total).toBe(0);
    expect(data.accounts).toEqual([]);
  });

  it('email-deliverability counts EmailLog rows across 24h and 7d windows', async () => {
    const res = await get('email-deliverability');
    const data = res.json().data as {
      last24h: { sent: number; error: number; noTransport: number; total: number };
      last7d: { total: number };
      topErrorApps: unknown[];
    };
    expect(data.last24h.total).toBe(
      data.last24h.sent + data.last24h.error + data.last24h.noTransport,
    );
    expect(typeof data.last7d.total).toBe('number');
    expect(Array.isArray(data.topErrorApps)).toBe(true);
  });

  it('webhook-endpoint-health and payments-by-app return arrays, empty or not', async () => {
    const health = await get('webhook-endpoint-health');
    expect(Array.isArray(health.json().data)).toBe(true);
    const byApp = await get('payments-by-app');
    expect(Array.isArray(byApp.json().data)).toBe(true);
  });

  it('applications can be filtered to one tenant', async () => {
    const t1 = await createTenant('FilterOne');
    const t2 = await createTenant('FilterTwo');
    const slug1 = `f1-${Math.random().toString(36).slice(2, 8)}`;
    await createApplication(t1, slug1);
    await createApplication(t2, `f2-${Math.random().toString(36).slice(2, 8)}`);

    const res = await get(`applications?tenantId=${t1}`);
    const filtered = res.json().data as Page & { items: Array<{ slug: string }> };
    expect(filtered.page.total).toBe(1);
    expect(filtered.items[0]!.slug).toBe(slug1);
  });

  it('api-requests reads the access log and filters by route path', async () => {
    // The onResponse hook buffers in memory and a timer flushes in one
    // createMany, so the row is not in Postgres when inject() resolves.
    await createTenant('Logged');
    await flushApiRequestLogs();

    const res = await get('api-requests?pathContains=/api/v1/admin/tenants');
    const matching = res.json().data as Page & {
      items: Array<{ routePath: string; method: string; statusCode: number }>;
    };
    expect(matching.items.length).toBeGreaterThan(0);
    expect(matching.page.total).toBe(matching.items.length);
    for (const row of matching.items) {
      // `pathContains` matches the route *pattern*, not the concrete URL.
      expect(row.routePath).toContain('/api/v1/admin/tenants');
    }
    expect(matching.items.some((r) => r.method === 'POST' && r.statusCode === 201)).toBe(true);

    // The filter excludes as well as includes — without this the assertion
    // above would pass on an unfiltered dump of the whole log.
    //
    // The non-matching row is created HERE rather than assumed. It used to
    // arrive on its own from whatever ran before this test: the request-log
    // buffer is a module-level global flushed by a timer, and nothing reset it
    // between tests, so earlier files' rows were still pending and landed on
    // this flush. `test/setup.ts` now drops that buffer in `beforeEach` (it is
    // the write the TRUNCATE deadlock retry exists to survive), which is
    // correct and leaves this test to supply its own contrast.
    await get('overview');
    await flushApiRequestLogs();
    const unfiltered = await get('api-requests');
    const all = unfiltered.json().data as Page;
    expect(all.page.total).toBeGreaterThan(matching.page.total);
  });
});
