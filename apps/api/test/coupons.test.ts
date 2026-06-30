/**
 * Coupons — admin CRUD, validate, apply-on-checkout, redemption tracking,
 * cross-application scoping.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('coupons', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;
  let userAccess: string;
  let userId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(): Promise<void> {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'CT', ownerEmail: 'ct@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'CApp', slug: 'c-app', enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    applicationId = application.id;
    liveKey = key.rawKey;

    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { slug: 'pro_monthly', name: 'Pro', amount: 999 },
    });

    const su = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: 'coupon-user@example.com', password: 'pw-one-two-three' },
    });
    const suData = su.json().data as { accessToken: string; endUser: { id: string } };
    userAccess = suData.accessToken;
    userId = suData.endUser.id;
  }

  async function createCoupon(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/coupons`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return res.json().data as Record<string, unknown>;
  }

  beforeEach(async () => {
    await bootstrap();
  });

  // ---------- admin CRUD ----------

  it('creates a PERCENT coupon (lowercased code, validated amount)', async () => {
    const c = await createCoupon({ code: 'LAUNCH50', discountType: 'PERCENT', amountOff: 5000 });
    expect(c.code).toBe('launch50');
    expect(c.discountType).toBe('PERCENT');
    expect(c.amountOff).toBe(5000);
  });

  it('rejects PERCENT coupon over 100%', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/coupons`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { code: 'tooMuch', discountType: 'PERCENT', amountOff: 15000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('COUPON_AMOUNT_INVALID');
  });

  it('rejects malformed code + duplicate', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/coupons`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { code: 'bad code', discountType: 'AMOUNT', amountOff: 100 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('COUPON_CODE_INVALID');

    await createCoupon({ code: 'dup', discountType: 'AMOUNT', amountOff: 100 });
    const dup = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/coupons`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { code: 'DUP', discountType: 'AMOUNT', amountOff: 100 },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('COUPON_CODE_TAKEN');
  });

  // ---------- validate ----------

  it('validates a PERCENT coupon and computes the right discount', async () => {
    await createCoupon({ code: 'fifteen', discountType: 'PERCENT', amountOff: 1500 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/coupons/validate',
      headers: { authorization: `Bearer ${liveKey}`, 'x-relipay-user-token': userAccess },
      payload: { code: 'FIFTEEN', planSlug: 'pro_monthly' },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { discountAmount: number; amountAfterDiscount: number };
    // 15% of 999 = 149.85 → floored to 149.
    expect(data.discountAmount).toBe(149);
    expect(data.amountAfterDiscount).toBe(850);
  });

  it('validates an AMOUNT coupon, clamps if discount > price', async () => {
    await createCoupon({ code: 'huge', discountType: 'AMOUNT', amountOff: 5000 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/coupons/validate',
      headers: { authorization: `Bearer ${liveKey}`, 'x-relipay-user-token': userAccess },
      payload: { code: 'huge', planSlug: 'pro_monthly' },
    });
    const data = res.json().data as { discountAmount: number; amountAfterDiscount: number };
    expect(data.discountAmount).toBe(999); // clamped to price
    expect(data.amountAfterDiscount).toBe(0);
  });

  it('rejects a coupon restricted to a different plan', async () => {
    await createCoupon({
      code: 'team-only',
      discountType: 'PERCENT',
      amountOff: 1000,
      planSlugs: ['team_annual'],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/coupons/validate',
      headers: { authorization: `Bearer ${liveKey}`, 'x-relipay-user-token': userAccess },
      payload: { code: 'team-only', planSlug: 'pro_monthly' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('COUPON_NOT_APPLICABLE');
  });

  it('rejects an expired coupon with COUPON_EXPIRED', async () => {
    await createCoupon({
      code: 'expired',
      discountType: 'PERCENT',
      amountOff: 1000,
      endsAt: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/coupons/validate',
      headers: { authorization: `Bearer ${liveKey}`, 'x-relipay-user-token': userAccess },
      payload: { code: 'expired', planSlug: 'pro_monthly' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('COUPON_EXPIRED');
  });

  // ---------- apply on checkout ----------

  it('applies a coupon on checkout WITHOUT recording redemption (deferred to payment success)', async () => {
    // Audit fix 2026-05-19: redemption is recorded by the Stripe webhook
    // at invoice.paid time, not at checkout creation. Abandoned checkouts
    // no longer consume per-user / global redemption limits.
    await createCoupon({ code: 'half', discountType: 'PERCENT', amountOff: 5000 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-relipay-user-token': userAccess },
      payload: {
        planSlug: 'pro_monthly',
        successUrl: 'https://x.example/ok',
        cancelUrl: 'https://x.example/cancel',
        couponCode: 'half',
      },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      discountAmount: number;
      subscription: { id: string; metadata: { couponId?: string; discountAmount?: number } };
    };
    expect(data.discountAmount).toBe(499); // 50% of 999 floor
    // The couponId rides on subscription metadata so the webhook can find
    // it at payment-success time.
    expect(data.subscription.metadata.couponId).toBeTruthy();

    // Critically: no redemption row exists yet.
    const redemptions = await prisma.couponRedemption.findMany({
      where: { applicationId, subscriptionId: data.subscription.id },
    });
    expect(redemptions).toHaveLength(0);
  });

  it('a bad coupon on checkout rejects the whole checkout', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-relipay-user-token': userAccess },
      payload: {
        planSlug: 'pro_monthly',
        successUrl: 'https://x.example/ok',
        cancelUrl: 'https://x.example/cancel',
        couponCode: 'no-such-thing',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('COUPON_NOT_FOUND');
    // No subscription created when coupon validation fails.
    const subs = await prisma.subscription.findMany({ where: { applicationId } });
    expect(subs).toHaveLength(0);
  });

  it('enforces maxRedemptionsPerUser at the recordRedemption (payment-success) boundary', async () => {
    // Audit fix 2026-05-19: limits are enforced atomically at
    // recordRedemption time (called from the Stripe webhook), not at
    // checkout. This test drives the limit via the service directly to
    // model what the webhook does on invoice.paid.
    const coupon = await createCoupon({
      code: 'once',
      discountType: 'PERCENT',
      amountOff: 1000,
      maxRedemptionsPerUser: 1,
    });

    // First validate passes — no redemptions yet.
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/coupons/validate',
      headers: { authorization: `Bearer ${liveKey}`, 'x-relipay-user-token': userAccess },
      payload: { code: 'once', planSlug: 'pro_monthly' },
    });
    expect(first.statusCode).toBe(200);

    // Simulate a successful payment recording the redemption (this is what
    // the Stripe webhook does on invoice.paid).
    const { couponsService } = await import('../src/modules/coupons/coupons.service.js');
    await couponsService.recordRedemption({
      couponId: coupon.id,
      applicationId,
      endUserId: userId,
      paymentId: 'pay_test_001',
    });

    // Validate again → atomic re-check inside transaction will reject.
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/coupons/validate',
      headers: { authorization: `Bearer ${liveKey}`, 'x-relipay-user-token': userAccess },
      payload: { code: 'once', planSlug: 'pro_monthly' },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe('COUPON_USER_LIMIT_REACHED');

    // A second recordRedemption (e.g. webhook replay for a different payment)
    // by the same user MUST be rejected, even though webhook replays for
    // the SAME paymentId are caught idempotently via the unique index.
    await expect(
      couponsService.recordRedemption({
        couponId: coupon.id,
        applicationId,
        endUserId: userId,
        paymentId: 'pay_test_002',
      }),
    ).rejects.toMatchObject({ code: 'COUPON_USER_LIMIT_REACHED' });
  });
});
