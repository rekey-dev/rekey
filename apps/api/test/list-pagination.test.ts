/**
 * List endpoints report truncation.
 *
 * ## The defect this exists for
 *
 * A functional audit called `GET /api/v1/tenant/applications/:id/end-users`
 * with no `limit`. There were 36 end-users in the database. It answered 200
 * with 25 rows and **nothing in the response said the other 11 existed**:
 *
 * ```
 * -> 200 [ ...25 rows... ]      actual rows in the database: 36
 * ```
 *
 * A client that does not pass `limit` cannot tell a complete list from a
 * silently truncated one, so it renders 25 and calls it the answer. Twenty-six
 * list endpoints had the same shape.
 *
 * The fix is the `{items, page}` envelope the published OpenAPI document had
 * already declared for all of them — `page` carries `{total, limit, offset,
 * hasMore}`, so "there is more" is a fact in the response rather than
 * something the caller has to infer by over-fetching.
 *
 * ## What these tests assert
 *
 * 1. The original defect, exactly: create more rows than the default page
 *    size, request without `limit`, and require that `page.total` exceeds
 *    `items.length` and `page.hasMore` is true.
 * 2. Paging with `offset` walks the whole set without overlap or gaps, and
 *    `hasMore` goes false on the last page.
 * 3. A representative endpoint from each shape of handler in the migration —
 *    service-backed, inline-Prisma, count-through-a-guard, and the two whose
 *    service clamps `limit` itself — returns the envelope rather than a bare
 *    array. The contract test (`openapi-contract.test.ts`) proves the
 *    *document* declares `{items, page}`; response schemas are documentation
 *    and not serialisation here (see lib/openapi.ts), so only a real request
 *    proves the *handler* agrees.
 * 4. The three endpoints whose envelope was wrong in a different way —
 *    `security-events` returned `{events}`, `admin/operator-invites` and the
 *    `admin/metrics/*` family returned pagination flattened one level up.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/** Shape of every paginated `data` in this API. */
interface PageEnvelope<T = unknown> {
  items: T[];
  page: { total: number; limit: number; offset: number; hasMore: boolean };
}

function expectEnvelope(body: unknown): PageEnvelope {
  const data = (body as { success: boolean; data: unknown }).data;
  expect(
    Array.isArray(data),
    'data is a bare array — the list envelope is `{items, page}`',
  ).toBe(false);
  const page = data as PageEnvelope;
  expect(Array.isArray(page.items)).toBe(true);
  expect(page.page).toEqual({
    total: expect.any(Number),
    limit: expect.any(Number),
    offset: expect.any(Number),
    hasMore: expect.any(Boolean),
  });
  // `hasMore` must be derivable from the other three, not independently
  // asserted by the handler — a `hasMore` that disagrees with `total` is worse
  // than no `hasMore`, because a pager trusts it.
  expect(page.page.hasMore).toBe(page.page.offset + page.page.limit < page.page.total);
  return page;
}

describe('list endpoints report truncation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** `test/setup.ts` truncates every domain table in beforeEach. */
  async function fixture(slug: string): Promise<{
    operatorToken: string;
    applicationId: string;
    liveKey: string;
  }> {
    const operatorToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    const applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);

    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'k', mode: 'live', scopes: ['auth:write', 'billing:read'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    return { operatorToken, applicationId, liveKey };
  }

  /**
   * Seed end-users straight through Prisma.
   *
   * 36 rows against a default page size of 25 — the exact numbers from the
   * audit report, so the test fails the way the bug was found.
   */
  async function seedEndUsers(applicationId: string, count: number): Promise<void> {
    await prisma.endUser.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        applicationId,
        // Zero-padded so lexical and creation order agree — the assertions
        // below page by `?sort=email` and compare against a sorted expectation.
        email: `bulk-${String(i).padStart(3, '0')}@example.com`,
        passwordHash: 'x',
        emailVerified: true,
      })),
    });
  }

  // -------------------------------------------------------------------------
  // 1. The original defect
  // -------------------------------------------------------------------------

  it('a list bigger than the default page says so — total > items.length, hasMore true', async () => {
    const { operatorToken, applicationId } = await fixture('trunc');
    await seedEndUsers(applicationId, 36);

    // No `limit` — the exact call from the audit report.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/end-users`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    expect(res.statusCode).toBe(200);
    const { items, page } = expectEnvelope(res.json());

    // The default page size for this endpoint is 25.
    expect(items).toHaveLength(25);
    expect(page.limit).toBe(25);
    expect(page.offset).toBe(0);
    // The whole point: the response says 36 exist and 25 were served.
    expect(page.total).toBe(36);
    expect(page.total).toBeGreaterThan(items.length);
    expect(page.hasMore).toBe(true);
  });

  it('paging with offset covers the set exactly once and clears hasMore on the last page', async () => {
    const { operatorToken, applicationId } = await fixture('paging');
    await seedEndUsers(applicationId, 36);

    const seen: string[] = [];
    for (let offset = 0; offset < 40; offset += 20) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${applicationId}/end-users?limit=20&offset=${offset}&sort=email&order=asc`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      const { items, page } = expectEnvelope(res.json());
      expect(page.total).toBe(36);
      expect(page.offset).toBe(offset);
      expect(page.hasMore).toBe(offset + 20 < 36);
      seen.push(...(items as Array<{ email: string }>).map((u) => u.email));
    }

    // No overlap, no gap: every seeded row appears exactly once.
    expect(seen).toHaveLength(36);
    expect(new Set(seen).size).toBe(36);
    expect(seen[0]).toBe('bulk-000@example.com');
    expect(seen[35]).toBe('bulk-035@example.com');
  });

  it('an empty list is still an envelope, not an empty array', async () => {
    const { operatorToken, applicationId } = await fixture('empty');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/end-users`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { items, page } = expectEnvelope(res.json());
    expect(items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2. One endpoint per handler shape in the migration
  // -------------------------------------------------------------------------

  it('operator list endpoints return the envelope', async () => {
    const { operatorToken, applicationId } = await fixture('shapes');
    const paths = [
      // service-backed + count
      '/api/v1/tenant/applications/',
      `/api/v1/tenant/applications/${applicationId}/plans`,
      `/api/v1/tenant/applications/${applicationId}/licenses`,
      `/api/v1/tenant/applications/${applicationId}/usage-meters`,
      `/api/v1/tenant/applications/${applicationId}/organizations`,
      `/api/v1/tenant/applications/${applicationId}/coupons`,
      // inline Prisma + count
      `/api/v1/tenant/applications/${applicationId}/payments`,
      `/api/v1/tenant/applications/${applicationId}/dunning`,
      `/api/v1/tenant/applications/${applicationId}/billing-credentials/webhook-events`,
      // service clamps limit itself, so `page.limit` is the served window
      `/api/v1/tenant/applications/${applicationId}/email-logs`,
      `/api/v1/tenant/applications/${applicationId}/webhooks`,
      '/api/v1/tenant/workspace/email-logs',
      // workspace-level
      '/api/v1/tenant/workspace/members',
      '/api/v1/tenant/workspace/invitations',
      '/api/v1/tenant/auth/sessions',
      '/api/v1/tenant/auth/api-tokens',
    ];

    for (const path of paths) {
      const res = await app.inject({
        method: 'GET',
        url: path,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode, `${path} answered ${res.statusCode}`).toBe(200);
      expectEnvelope(res.json());
    }
  });

  it('end-user-facing list endpoints return the envelope', async () => {
    const { liveKey, applicationId } = await fixture('enduser');

    const userToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: 'eu-shapes@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    for (const path of [
      '/api/v1/billing/plans',
      '/api/v1/billing/payments',
      '/api/v1/auth/sessions',
      '/api/v1/auth/passkeys',
      '/api/v1/users/me/organizations/',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: path,
        headers: {
          authorization: `Bearer ${liveKey}`,
          'x-rekey-user-token': userToken,
        },
      });
      expect(res.statusCode, `${path} answered ${res.statusCode}`).toBe(200);
      expectEnvelope(res.json());
    }

    // The credits ledger takes a secret key + an explicit subject.
    const ledger = await app.inject({
      method: 'GET',
      url: `/api/v1/credits/ledger?endUserId=${
        (
          await prisma.endUser.findFirstOrThrow({
            where: { applicationId, email: 'eu-shapes@example.com' },
          })
        ).id
      }`,
      headers: { authorization: `Bearer ${liveKey}` },
    });
    expect(ledger.statusCode).toBe(200);
    expectEnvelope(ledger.json());
  });

  // -------------------------------------------------------------------------
  // 3. The three that were wrong in a different way
  // -------------------------------------------------------------------------

  it('security-events returns {items, page}, not {events}', async () => {
    const { operatorToken } = await fixture('sec-events');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/security-events',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Record<string, unknown>;
    expect(
      'events' in data,
      'security-events still returns the undocumented `{events}` key',
    ).toBe(false);
    const { items, page } = expectEnvelope(res.json());
    // The sign-up + Application create above emit events, so this is not
    // vacuously true on an empty log.
    expect(items.length).toBeGreaterThan(0);
    expect(page.total).toBeGreaterThan(0);
  });

  it('admin metrics nest pagination under `page` instead of flattening it', async () => {
    await fixture('admin-metrics');
    const adminKey = process.env.SUPER_ADMIN_KEY!;
    for (const path of [
      '/api/v1/admin/metrics/tenants',
      '/api/v1/admin/metrics/applications',
      '/api/v1/admin/metrics/end-users',
      '/api/v1/admin/metrics/tenant-users',
      '/api/v1/admin/metrics/security-events',
      '/api/v1/admin/metrics/api-requests',
      '/api/v1/admin/metrics/payments',
      '/api/v1/admin/metrics/subscriptions',
      '/api/v1/admin/metrics/webhook-events',
      '/api/v1/admin/metrics/webhook-deliveries',
      '/api/v1/admin/operator-invites',
      '/api/v1/admin/tenants',
      '/api/v1/admin/applications',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: path,
        headers: { authorization: `Bearer ${adminKey}` },
      });
      expect(res.statusCode, `${path} answered ${res.statusCode}`).toBe(200);
      const data = res.json().data as Record<string, unknown>;
      expect('total' in data, `${path} still flattens \`total\` next to \`items\``).toBe(false);
      expectEnvelope(res.json());
    }
  });
});
