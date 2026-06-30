/**
 * Operator panel list features:
 *   - GET /tenant/applications/:id/payments (status/from/to filters + email join)
 *   - GET /tenant/applications/:id/end-users (emailVerified + subscriptionStatus filters)
 *   - GET /tenant/applications/:id/coupons (redemptionCount + totalDiscountIssued stats)
 *   - GET /tenant/security-events (from/to filters + ?format=csv export)
 *
 * Rows that normally arrive via provider webhooks (payments, subscriptions,
 * redemptions, security events) are seeded directly with prisma — the writers
 * are covered by their own suites; these tests exercise the read/aggregate
 * surface the panel consumes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

interface Bootstrapped {
  applicationId: string;
  tenantId: string;
  liveKey: string;
  tenantAccess: string;
}

describe('operator panel features', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    const session = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-opf-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS opf ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string; activeTenantId: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { name: `App opf ${slug}`, slug: `opf-${slug}`, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    return {
      applicationId: application.id,
      tenantId: session.activeTenantId,
      liveKey: key.rawKey,
      tenantAccess: session.accessToken,
    };
  }

  async function signUpEndUser(b: Bootstrapped, email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { endUser: { id: string } }).endUser.id;
  }

  // ---------- payments list ----------

  it('payments: lists newest-first with status/date filters, pagination + end-user email join', async () => {
    const b = await bootstrap('pay');
    const endUserId = await signUpEndUser(b, 'payer-opf@example.com');

    await prisma.payment.create({
      data: {
        applicationId: b.applicationId,
        endUserId,
        amount: 999,
        currency: 'USD',
        status: 'SUCCEEDED',
        providerPaymentId: 'opf-pay-new',
        createdAt: new Date('2026-06-01T12:00:00Z'),
      },
    });
    await prisma.payment.create({
      data: {
        applicationId: b.applicationId,
        endUserId: null,
        amount: 500,
        currency: 'USD',
        status: 'FAILED',
        providerPaymentId: 'opf-pay-failed',
        createdAt: new Date('2026-03-01T12:00:00Z'),
      },
    });
    await prisma.payment.create({
      data: {
        applicationId: b.applicationId,
        endUserId,
        amount: 250,
        currency: 'USD',
        status: 'SUCCEEDED',
        providerPaymentId: 'opf-pay-old',
        createdAt: new Date('2026-01-01T12:00:00Z'),
      },
    });

    // Unfiltered: newest first, email joined where attributable.
    const all = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/payments`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(all.statusCode).toBe(200);
    const rows = all.json().data as Array<{
      providerPaymentId: string;
      status: string;
      endUserEmail: string | null;
      amount: number;
    }>;
    expect(rows.map((r) => r.providerPaymentId)).toEqual([
      'opf-pay-new',
      'opf-pay-failed',
      'opf-pay-old',
    ]);
    expect(rows[0]!.endUserEmail).toBe('payer-opf@example.com');
    expect(rows[1]!.endUserEmail).toBeNull();

    // Status filter.
    const failed = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/payments?status=FAILED`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    const failedRows = failed.json().data as Array<{ providerPaymentId: string }>;
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]!.providerPaymentId).toBe('opf-pay-failed');

    // Date window catches only the middle payment.
    const windowed = await app.inject({
      method: 'GET',
      url:
        `/api/v1/tenant/applications/${b.applicationId}/payments` +
        `?from=${encodeURIComponent('2026-02-01T00:00:00Z')}&to=${encodeURIComponent('2026-04-01T00:00:00Z')}`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    const windowedRows = windowed.json().data as Array<{ providerPaymentId: string }>;
    expect(windowedRows.map((r) => r.providerPaymentId)).toEqual(['opf-pay-failed']);

    // Pagination.
    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/payments?limit=1&offset=1`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    const page2Rows = page2.json().data as Array<{ providerPaymentId: string }>;
    expect(page2Rows.map((r) => r.providerPaymentId)).toEqual(['opf-pay-failed']);
  });

  it('payments: ?sort/?order re-order rows; sort values outside the allowlist are rejected', async () => {
    const b = await bootstrap('paysort');
    for (const [amount, status, ref, createdAt] of [
      [999, 'SUCCEEDED', 'sort-mid', '2026-06-01T12:00:00Z'],
      [500, 'FAILED', 'sort-low', '2026-05-01T12:00:00Z'],
      [2500, 'PENDING', 'sort-high', '2026-04-01T12:00:00Z'],
    ] as const) {
      await prisma.payment.create({
        data: {
          applicationId: b.applicationId,
          amount,
          currency: 'USD',
          status,
          providerPaymentId: `opf-${ref}`,
          createdAt: new Date(createdAt),
        },
      });
    }

    const list = async (qs: string): Promise<Array<{ providerPaymentId: string }>> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${b.applicationId}/payments${qs}`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      });
      expect(res.statusCode).toBe(200);
      return res.json().data as Array<{ providerPaymentId: string }>;
    };

    // amount ascending / descending.
    expect((await list('?sort=amount&order=asc')).map((r) => r.providerPaymentId)).toEqual([
      'opf-sort-low',
      'opf-sort-mid',
      'opf-sort-high',
    ]);
    expect((await list('?sort=amount&order=desc')).map((r) => r.providerPaymentId)).toEqual([
      'opf-sort-high',
      'opf-sort-mid',
      'opf-sort-low',
    ]);
    // status ascending — Postgres enums sort by definition order
    // (PENDING < SUCCEEDED < FAILED < REFUNDED), not lexicographically.
    expect((await list('?sort=status&order=asc')).map((r) => r.providerPaymentId)).toEqual([
      'opf-sort-high',
      'opf-sort-mid',
      'opf-sort-low',
    ]);
    // createdAt asc flips the default newest-first.
    expect((await list('?sort=createdAt&order=asc')).map((r) => r.providerPaymentId)).toEqual([
      'opf-sort-high',
      'opf-sort-low',
      'opf-sort-mid',
    ]);
    // No sort params → existing behavior (newest first).
    expect((await list('')).map((r) => r.providerPaymentId)).toEqual([
      'opf-sort-mid',
      'opf-sort-low',
      'opf-sort-high',
    ]);

    // Allowlist: arbitrary columns are rejected, not silently ignored.
    for (const qs of ['?sort=passwordHash', '?sort=metadata', '?sort=amount&order=sideways']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${b.applicationId}/payments${qs}`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('end-users: ?sort=email orders alphabetically; security-events: ?sort=type works', async () => {
    const b = await bootstrap('eusort');
    for (const email of ['charlie@example.com', 'alice@example.com', 'bob@example.com']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${b.applicationId}/end-users`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: { email },
      });
      expect(res.statusCode).toBe(201);
    }
    const asc = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users?sort=email&order=asc`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(asc.statusCode).toBe(200);
    expect((asc.json().data as Array<{ email: string }>).map((u) => u.email)).toEqual([
      'alice@example.com',
      'bob@example.com',
      'charlie@example.com',
    ]);
    const badSort = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users?sort=role`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(badSort.statusCode).toBe(400);

    // Security events: type asc vs default createdAt desc.
    await prisma.securityEvent.create({
      data: {
        tenantId: b.tenantId,
        actorType: 'operator',
        type: 'zzz.test_event',
        createdAt: new Date('2026-06-02T12:00:00Z'),
      },
    });
    await prisma.securityEvent.create({
      data: {
        tenantId: b.tenantId,
        actorType: 'operator',
        type: 'aaa.test_event',
        createdAt: new Date('2026-06-01T12:00:00Z'),
      },
    });
    const byType = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/security-events?sort=type&order=asc',
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(byType.statusCode).toBe(200);
    const types = (byType.json().data as { events: Array<{ type: string }> }).events.map((e) => e.type);
    expect(types[0]).toBe('aaa.test_event');
    expect(types[types.length - 1]).toBe('zzz.test_event');
    const badEventSort = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/security-events?sort=ip',
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(badEventSort.statusCode).toBe(400);
  });

  it('payments: an operator from another workspace gets 404 (tenant scoping)', async () => {
    const b = await bootstrap('payscope');
    const other = await bootstrap('payscope2');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/payments`,
      headers: { authorization: `Bearer ${other.tenantAccess}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('APPLICATION_NOT_FOUND');
  });

  // ---------- end-user list filters ----------

  it('end-users: filters by emailVerified and subscriptionStatus', async () => {
    const b = await bootstrap('eufilter');

    // Seed via the operator create endpoint (sets emailVerified explicitly).
    for (const [email, verified] of [
      ['verified-active@example.com', true],
      ['unverified@example.com', false],
      ['verified-canceled@example.com', true],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${b.applicationId}/end-users`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: { email, emailVerified: verified },
      });
      expect(res.statusCode).toBe(201);
    }
    const byEmail = new Map(
      (
        await prisma.endUser.findMany({
          where: { applicationId: b.applicationId },
          select: { id: true, email: true },
        })
      ).map((u) => [u.email, u.id]),
    );

    const plan = await prisma.plan.create({
      data: { applicationId: b.applicationId, slug: 'opf-pro', name: 'Pro', amount: 999 },
    });
    await prisma.subscription.create({
      data: {
        applicationId: b.applicationId,
        endUserId: byEmail.get('verified-active@example.com')!,
        planId: plan.id,
        status: 'ACTIVE',
      },
    });
    await prisma.subscription.create({
      data: {
        applicationId: b.applicationId,
        endUserId: byEmail.get('verified-canceled@example.com')!,
        planId: plan.id,
        status: 'CANCELED',
      },
    });

    const list = async (qs: string): Promise<string[]> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${b.applicationId}/end-users${qs}`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      });
      expect(res.statusCode).toBe(200);
      return (res.json().data as Array<{ email: string }>).map((u) => u.email).sort();
    };

    expect(await list('?emailVerified=false')).toEqual(['unverified@example.com']);
    expect(await list('?emailVerified=true')).toEqual([
      'verified-active@example.com',
      'verified-canceled@example.com',
    ]);
    expect(await list('?subscriptionStatus=ACTIVE')).toEqual(['verified-active@example.com']);
    expect(await list('?subscriptionStatus=CANCELED')).toEqual([
      'verified-canceled@example.com',
    ]);
    // Filters compose (verified AND active).
    expect(await list('?emailVerified=true&subscriptionStatus=ACTIVE')).toEqual([
      'verified-active@example.com',
    ]);
    expect(await list('?emailVerified=false&subscriptionStatus=ACTIVE')).toEqual([]);
  });

  // ---------- coupon redemption stats ----------

  it('coupons: list carries redemptionCount + totalDiscountIssued aggregates', async () => {
    const b = await bootstrap('coupstats');
    const endUserId = await signUpEndUser(b, 'redeemer-opf@example.com');

    const createCoupon = async (body: Record<string, unknown>): Promise<{ id: string; code: string }> => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${b.applicationId}/coupons`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: body,
      });
      expect(res.statusCode).toBe(201);
      return res.json().data as { id: string; code: string };
    };
    const percent = await createCoupon({ code: 'pct15', discountType: 'PERCENT', amountOff: 1500 });
    const amount = await createCoupon({ code: 'flat5', discountType: 'AMOUNT', amountOff: 500 });
    await createCoupon({ code: 'unused', discountType: 'AMOUNT', amountOff: 100 });

    // PERCENT redemption: the actual discount is recorded on the
    // subscription's metadata at checkout time — the stats read it back.
    const plan = await prisma.plan.create({
      data: { applicationId: b.applicationId, slug: 'opf-coup', name: 'Coup', amount: 999 },
    });
    const sub = await prisma.subscription.create({
      data: {
        applicationId: b.applicationId,
        endUserId,
        planId: plan.id,
        status: 'ACTIVE',
        metadata: { couponId: percent.id, discountAmount: 149 },
      },
    });
    await prisma.couponRedemption.create({
      data: {
        couponId: percent.id,
        applicationId: b.applicationId,
        endUserId,
        subscriptionId: sub.id,
      },
    });
    // AMOUNT redemptions without a linked subscription fall back to amountOff.
    for (const paymentId of ['opf-redeem-1', 'opf-redeem-2']) {
      await prisma.couponRedemption.create({
        data: { couponId: amount.id, applicationId: b.applicationId, endUserId, paymentId },
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/coupons`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(res.statusCode).toBe(200);
    const coupons = res.json().data as Array<{
      code: string;
      redemptionCount: number;
      totalDiscountIssued: number;
    }>;
    const byCode = new Map(coupons.map((c) => [c.code, c]));
    expect(byCode.get('pct15')).toMatchObject({ redemptionCount: 1, totalDiscountIssued: 149 });
    expect(byCode.get('flat5')).toMatchObject({ redemptionCount: 2, totalDiscountIssued: 1000 });
    expect(byCode.get('unused')).toMatchObject({ redemptionCount: 0, totalDiscountIssued: 0 });
  });

  // ---------- audit log filters + CSV export ----------

  it('security-events: from/to filters narrow the window; ?format=csv downloads a capped CSV', async () => {
    const b = await bootstrap('audit');

    // Seed deterministic events (writers are covered by their own suites).
    await prisma.securityEvent.create({
      data: {
        tenantId: b.tenantId,
        actorType: 'operator',
        type: 'operator.sign_in',
        ip: '203.0.113.7',
        userAgent: 'opf-test-agent',
        createdAt: new Date('2026-06-01T12:00:00Z'),
      },
    });
    await prisma.securityEvent.create({
      data: {
        tenantId: b.tenantId,
        applicationId: b.applicationId,
        actorType: 'operator',
        type: 'app.api_key.created',
        createdAt: new Date('2026-03-01T12:00:00Z'),
      },
    });
    await prisma.securityEvent.create({
      data: {
        tenantId: b.tenantId,
        applicationId: b.applicationId,
        actorType: 'end_user',
        type: 'user.signed_in',
        createdAt: new Date('2026-01-01T12:00:00Z'),
      },
    });

    const listTypes = async (qs: string): Promise<string[]> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/security-events${qs}`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      });
      expect(res.statusCode).toBe(200);
      return (res.json().data as { events: Array<{ type: string }> }).events.map((e) => e.type);
    };

    // Date window catches only the middle event (inclusive bounds).
    expect(
      await listTypes(
        `?from=${encodeURIComponent('2026-02-01T00:00:00Z')}&to=${encodeURIComponent('2026-04-01T00:00:00Z')}`,
      ),
    ).toEqual(['app.api_key.created']);
    // A future-only window is empty.
    expect(await listTypes(`?from=${encodeURIComponent('2027-01-01T00:00:00Z')}`)).toEqual([]);
    // Existing type/actorType filters still compose with the window.
    expect(
      await listTypes(`?actorType=end_user&to=${encodeURIComponent('2026-02-01T00:00:00Z')}`),
    ).toEqual(['user.signed_in']);

    // CSV export: text/csv attachment, header row + the seeded rows, filters apply.
    const csv = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/security-events?format=csv&actorType=operator`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('attachment');
    const lines = csv.body.trim().split('\n');
    expect(lines[0]).toBe('id,type,actorType,actorId,applicationId,ip,userAgent,metadata,createdAt');
    expect(csv.body).toContain('"operator.sign_in"');
    expect(csv.body).toContain('"203.0.113.7"');
    expect(csv.body).toContain('"app.api_key.created"');
    // actorType filter applied — the end_user event is excluded.
    expect(csv.body).not.toContain('"user.signed_in"');
  });
});
