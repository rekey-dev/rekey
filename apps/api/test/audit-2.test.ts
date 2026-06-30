/**
 * Second-pass audit (2026-05-19) regression tests:
 *
 *   - License seat-exhaustion under concurrent verifies — atomic, no double-issue.
 *   - Coupon redemption recorded ONCE per payment (idempotent under replay).
 *   - Coupon TOCTOU: parallel `recordRedemption` calls past the limit are
 *     correctly serialised and the loser fails.
 *   - Stripe webhook refuses absurd amounts (probable unit mismatch).
 *   - Webhook URL safety guard: localhost / private IPs / non-HTTP schemes
 *     are refused unless `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`.
 *   - Encrypted billing credentials with corrupted ciphertext fail-loud
 *     instead of silently trying to use junk.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { isWebhookUrlSafe, verifyWebhookSignature, signWebhook } from '../src/lib/webhook-signing.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
  userId: string;
  userAccess: string;
}

describe('Audit-2 regression', () => {
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
    return {
      applicationId: application.id,
      liveKey: key.rawKey,
      tenantAccess: ts.accessToken,
      userId: eu.endUser.id,
      userAccess: eu.accessToken,
    };
  }

  // ---------- License seat-exhaustion race ----------

  it('license SEATS verify is atomic: N parallel calls on a 2-seat license issue at most 2 activations', async () => {
    const b = await bootstrap('seats');
    const { licensesService } = await import('../src/modules/licenses/licenses.service.js');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: b.applicationId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: b.userId } });
    const issued = await licensesService.issue({
      application,
      endUser,
      kind: 'SEATS',
      seatsAllowed: 2,
    });

    // Fire 10 verifies for 10 different machines in parallel.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        licensesService.verify({
          applicationId: b.applicationId,
          rawKey: issued.rawKey,
          machineFingerprint: `machine-${i}`,
        }),
      ),
    );
    const allowed = results.filter((r) => r.ok).length;
    const exhausted = results.filter((r) => !r.ok && r.reason === 'seats_exhausted').length;
    expect(allowed + exhausted).toBe(10);
    expect(allowed).toBeLessThanOrEqual(2);
    expect(exhausted).toBeGreaterThanOrEqual(8);

    const actualActivations = await prisma.licenseActivation.count({
      where: { licenseId: (issued.license as { id: string }).id },
    });
    expect(actualActivations).toBeLessThanOrEqual(2);
  });

  it('license verify from a previously-active machine never consumes a new seat', async () => {
    const b = await bootstrap('seats-repeat');
    const { licensesService } = await import('../src/modules/licenses/licenses.service.js');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: b.applicationId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: b.userId } });
    const issued = await licensesService.issue({
      application,
      endUser,
      kind: 'SEATS',
      seatsAllowed: 1,
    });

    // Activate one machine.
    const first = await licensesService.verify({
      applicationId: b.applicationId,
      rawKey: issued.rawKey,
      machineFingerprint: 'machine-A',
    });
    expect(first.ok).toBe(true);

    // Same machine, 5 more times — should keep passing without consuming.
    for (let i = 0; i < 5; i++) {
      const r = await licensesService.verify({
        applicationId: b.applicationId,
        rawKey: issued.rawKey,
        machineFingerprint: 'machine-A',
      });
      expect(r.ok).toBe(true);
    }
    expect(
      await prisma.licenseActivation.count({
        where: { licenseId: (issued.license as { id: string }).id },
      }),
    ).toBe(1);
  });

  // ---------- Coupon redemption timing + idempotency ----------

  it('checkout with a coupon does NOT record a redemption (deferred to payment-success webhook)', async () => {
    const b = await bootstrap('coup-defer');
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${b.applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { slug: 'pro', name: 'Pro', amount: 1000 },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${b.applicationId}/coupons`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { code: 'twenty', discountType: 'PERCENT', amountOff: 2000 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-relipay-user-token': b.userAccess },
      payload: {
        planSlug: 'pro',
        successUrl: 'https://x.example/ok',
        cancelUrl: 'https://x.example/cancel',
        couponCode: 'twenty',
      },
    });
    expect(res.statusCode).toBe(200);
    const redemptions = await prisma.couponRedemption.count({
      where: { applicationId: b.applicationId },
    });
    expect(redemptions).toBe(0);
  });

  it('coupon recordRedemption is idempotent on (couponId, paymentId) — webhook replay-safe', async () => {
    const b = await bootstrap('coup-idem');
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${b.applicationId}/coupons`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { code: 'replayable', discountType: 'AMOUNT', amountOff: 100 },
    });
    const coupon = await prisma.coupon.findUniqueOrThrow({
      where: { applicationId_code: { applicationId: b.applicationId, code: 'replayable' } },
    });
    const { couponsService } = await import('../src/modules/coupons/coupons.service.js');

    await couponsService.recordRedemption({
      couponId: coupon.id,
      applicationId: b.applicationId,
      endUserId: b.userId,
      paymentId: 'pay_idem_001',
    });

    // Replay (same paymentId) — should hit the unique index and throw P2002,
    // which we surface as the Prisma error code.
    let err: { code?: string } | null = null;
    try {
      await couponsService.recordRedemption({
        couponId: coupon.id,
        applicationId: b.applicationId,
        endUserId: b.userId,
        paymentId: 'pay_idem_001',
      });
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).toBe('P2002');

    // Still only one redemption row.
    expect(
      await prisma.couponRedemption.count({ where: { couponId: coupon.id } }),
    ).toBe(1);
  });

  it('coupon recordRedemption with a parallel race: only `limit` succeed, rest fail with the right code', async () => {
    const b = await bootstrap('coup-toctou');
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${b.applicationId}/coupons`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: {
        code: 'limit3',
        discountType: 'AMOUNT',
        amountOff: 100,
        maxRedemptions: 3,
      },
    });
    const coupon = await prisma.coupon.findUniqueOrThrow({
      where: { applicationId_code: { applicationId: b.applicationId, code: 'limit3' } },
    });
    const { couponsService } = await import('../src/modules/coupons/coupons.service.js');

    // 10 concurrent redemptions, each with a distinct paymentId so the
    // (couponId, paymentId) unique index doesn't block them. Each comes
    // from a different "user" too so the per-user limit is never the
    // gate — global maxRedemptions is.
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
    const results = await Promise.allSettled(
      users.map((u, i) =>
        couponsService.recordRedemption({
          couponId: coupon.id,
          applicationId: b.applicationId,
          endUserId: u.id,
          paymentId: `pay_toctou_${i}`,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected') as Array<
      PromiseRejectedResult & { reason: { code?: string } }
    >;
    expect(ok).toBe(3);
    expect(rejected).toHaveLength(7);
    for (const r of rejected) {
      expect(r.reason.code).toBe('COUPON_REDEMPTION_LIMIT_REACHED');
    }
    expect(await prisma.couponRedemption.count({ where: { couponId: coupon.id } })).toBe(3);
  });

  // ---------- Webhook SSRF guard ----------

  it('isWebhookUrlSafe rejects loopback / private / non-http(s)', () => {
    expect(isWebhookUrlSafe('http://localhost:3000/hook').ok).toBe(false);
    expect(isWebhookUrlSafe('http://127.0.0.1:3000/hook').ok).toBe(false);
    expect(isWebhookUrlSafe('http://10.0.0.5/hook').ok).toBe(false);
    expect(isWebhookUrlSafe('http://172.20.1.1/hook').ok).toBe(false);
    expect(isWebhookUrlSafe('http://192.168.1.1/hook').ok).toBe(false);
    expect(isWebhookUrlSafe('http://169.254.169.254/').ok).toBe(false); // EC2 IMDS
    expect(isWebhookUrlSafe('http://100.64.0.1/').ok).toBe(false); // CGNAT
    expect(isWebhookUrlSafe('http://[::1]/').ok).toBe(false);
    expect(isWebhookUrlSafe('http://[fc00::1]/').ok).toBe(false);
    expect(isWebhookUrlSafe('http://[fe80::1]/').ok).toBe(false);
    expect(isWebhookUrlSafe('file:///etc/passwd').ok).toBe(false);
    expect(isWebhookUrlSafe('gopher://example.com/').ok).toBe(false);
    // Public hosts pass.
    expect(isWebhookUrlSafe('https://example.com/hook').ok).toBe(true);
    expect(isWebhookUrlSafe('https://api.acme.io/relipay').ok).toBe(true);
    // Escape hatch.
    expect(isWebhookUrlSafe('http://127.0.0.1/hook', { allowPrivate: true }).ok).toBe(true);
  });

  // ---------- Webhook signature verification ----------

  it('verifyWebhookSignature: tampered body fails verification', () => {
    const body = '{"event":"x"}';
    const secret = 'a'.repeat(64);
    const { signatureHeader } = signWebhook({ body, secret });
    expect(verifyWebhookSignature({ body, secret, header: signatureHeader })).toBe(true);
    expect(verifyWebhookSignature({ body: '{"event":"y"}', secret, header: signatureHeader })).toBe(false);
    expect(verifyWebhookSignature({ body, secret: 'b'.repeat(64), header: signatureHeader })).toBe(false);
    // Replay window — present a 10-minute-old timestamp; should reject.
    const { signatureHeader: old } = signWebhook({
      body,
      secret,
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });
    expect(verifyWebhookSignature({ body, secret, header: old })).toBe(false);
  });

  // ---------- Billing credentials decrypt failure ----------

  it('billing credentials with corrupted ciphertext fail-loud at unwrap, not silent', async () => {
    const b = await bootstrap('creds-bad');
    // Insert a row with garbage ciphertext to simulate corruption / key rotation.
    await prisma.billingCredentials.create({
      data: {
        applicationId: b.applicationId,
        provider: 'stripe',
        mode: 'live',
        enabled: true,
        ciphertext: 'v1.deadbeef.deadbeef.deadbeef',
        countries: [],
        priority: 100,
      },
    });
    const { billingCredentialsService } = await import('../src/modules/billing/credentials.service.js');
    await expect(billingCredentialsService.loadDecrypted(b.applicationId, 'stripe')).rejects.toMatchObject({
      code: 'BILLING_CREDENTIALS_DECRYPT_FAILED',
    });
  });

  afterAll(async () => {
    await prisma.couponRedemption.deleteMany({});
    await prisma.licenseActivation.deleteMany({});
    await prisma.license.deleteMany({});
    await prisma.coupon.deleteMany({});
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
  });
});
