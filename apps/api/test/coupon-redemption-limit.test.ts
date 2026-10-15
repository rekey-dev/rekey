/**
 * A coupon is redeemed once per checkout and never past its limit: checkout
 * reserves a slot, payment confirms it, a replayed webhook confirms nothing
 * new, and parallel redemptions past the limit are reported as refused.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
  userId: string;
  userAccess: string;
}

describe('coupon redemptions stay within the limit', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    const ts = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-a2-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${ts.accessToken}` },
        payload: { name: `App ${slug}`, slug: `a2-${slug}`, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ts.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${key.rawKey}` },
        payload: { email: `eu-a2-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then(
        (r) =>
          r.json().data as {
            accessToken: string;
            endUser: { id: string };
          },
      );
    await configureSandboxStripe(application.id);
    return {
      applicationId: application.id,
      liveKey: key.rawKey,
      tenantAccess: ts.accessToken,
      userId: eu.endUser.id,
      userAccess: eu.accessToken,
    };
  }

  // Checkout now takes a RESERVATION, not a confirmed redemption. Deferring
  // everything to payment-success is what let a maxRedemptions:1 coupon
  // discount an unlimited number of concurrent checkouts, the limit was
  // counted against rows that did not exist yet. The reservation holds the
  // slot; only payment success confirms it.
  it('coupon redemption is idempotent per checkout session, webhook replay-safe', async () => {
    const b = await bootstrap('coup-idem');
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${b.applicationId}/coupons`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { code: 'replayable', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 100 }] },
    });
    const coupon = await prisma.coupon.findUniqueOrThrow({
      where: { applicationId_code: { applicationId: b.applicationId, code: 'replayable' } },
    });
    const { couponsService } = await import('../src/modules/coupons/coupons.service.js');

    const args = {
      couponId: coupon.id,
      applicationId: b.applicationId,
      endUserId: b.userId,
      checkoutSessionId: 'cs_idem_001',
      paymentId: 'pay_idem_001',
    };
    await expect(couponsService.redeemForCheckout(args)).resolves.toEqual({ recorded: true });

    // Replay. The idempotency key is the CHECKOUT SESSION, not the payment:
    // a one-time sale has no payment event at all, and a recurring one has a
    // fresh invoice id every period for the same single discount. Reported,
    // not thrown, the callers are webhook appliers writing money.
    await expect(couponsService.redeemForCheckout(args)).resolves.toEqual({
      recorded: false,
      reason: 'already-redeemed',
    });

    // Still only one redemption row.
    expect(
      await prisma.couponRedemption.count({ where: { couponId: coupon.id } }),
    ).toBe(1);
  });

  it('coupon redemption with a parallel race: only `limit` succeed, rest report the right code', async () => {
    const b = await bootstrap('coup-toctou');
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${b.applicationId}/coupons`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: {
        code: 'limit3',
        discountType: 'AMOUNT',
        amounts: [{ currency: 'USD', amountOff: 100 }],
        maxRedemptions: 3,
      },
    });
    const coupon = await prisma.coupon.findUniqueOrThrow({
      where: { applicationId_code: { applicationId: b.applicationId, code: 'limit3' } },
    });
    const { couponsService } = await import('../src/modules/coupons/coupons.service.js');

    // 10 concurrent redemptions, each for a distinct checkout session so the
    // (couponId, checkoutSessionId) unique index doesn't block them. Each
    // comes from a different "user" too so the per-user limit is never the
    // gate, global maxRedemptions is.
    const eu = await prisma.endUser.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        applicationId: b.applicationId,
        email: `r-${i}-${Date.now()}@example.com`,
        role: 'user',
      })),
    });
    expect(eu.count).toBe(10);
    const users = await prisma.endUser.findMany({
      where: { applicationId: b.applicationId, email: { contains: '@example.com' } },
      take: 10,
      orderBy: { createdAt: 'desc' },
    });
    const results = await Promise.all(
      users.map((u, i) =>
        couponsService.redeemForCheckout({
          couponId: coupon.id,
          applicationId: b.applicationId,
          endUserId: u.id,
          checkoutSessionId: `cs_toctou_${i}`,
          paymentId: `pay_toctou_${i}`,
        }),
      ),
    );
    const ok = results.filter((r) => r.recorded).length;
    const refused = results.filter((r) => !r.recorded);
    expect(ok).toBe(3);
    expect(refused).toHaveLength(7);
    for (const r of refused) {
      // A limit refusal is REPORTED rather than raised, the callers are
      // webhook appliers that must not have a payment rolled back under them.
      expect(r).toMatchObject({ reason: 'limit-reached', code: 'COUPON_REDEMPTION_LIMIT_REACHED' });
    }
    expect(await prisma.couponRedemption.count({ where: { couponId: coupon.id } })).toBe(3);
  });

  afterAll(async () => {
    await prisma.couponRedemption.deleteMany({});
    await prisma.licenseActivation.deleteMany({});
    await prisma.license.deleteMany({});
    await prisma.coupon.deleteMany({});
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
  });
});
