/**
 * Razorpay webhook ingestion — signature verification (offline HMAC-SHA256),
 * durable idempotency, state-machine transitions.
 *
 * No real Razorpay account: we sign the raw body with HMAC-SHA256(secret) — the
 * same digest the verifier checks — so the whole flow runs in CI.
 */

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { creditsService } from '../src/modules/credits/credits.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const SLUG = 'rzp-app';
const WEBHOOK_SECRET = 'rzp_whsec_test_secret_for_ci_only';

function signed(body: object, eventId = 'evt_rzp_default'): {
  payload: string;
  headers: Record<string, string>;
} {
  const payload = JSON.stringify(body);
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  return {
    payload,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': sig,
      'x-razorpay-event-id': eventId,
    },
  };
}

const URL = `/api/v1/billing/webhook/razorpay/${SLUG}`;

describe('POST /api/v1/billing/webhook/razorpay/:slug', () => {
  let app: FastifyInstance;
  let applicationId: string;

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
        payload: { name: 'RT', ownerEmail: 'rt@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'RApp', slug: SLUG, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    applicationId = application.id;

    await billingCredentialsService.upsertRazorpay(
      applicationId,
      { keyId: 'rzp_test_ci', keySecret: 'secret_ci', webhookSecret: WEBHOOK_SECRET },
      { enabled: true, mode: 'test' },
    );

    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { slug: 'pro_monthly', name: 'Pro', amount: 49900 },
    });
  }

  beforeEach(async () => {
    await bootstrap();
  });

  // ---------- signature ----------

  it('rejects requests with no x-razorpay-signature header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('WEBHOOK_SIGNATURE_MISSING');
  });

  it('rejects requests with a forged signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: URL,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': 'deadbeef',
        'x-razorpay-event-id': 'evt_forged',
      },
      payload: JSON.stringify({ event: 'subscription.activated', payload: {} }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('refuses (503) when the slug has no Razorpay webhook secret configured', async () => {
    const t = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'NoCreds', ownerEmail: 'nc-rzp@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { tenantId: t.id, name: 'NoCredsApp', slug: 'nc-rzp-app' },
    });
    const { payload, headers } = signed({ event: 'subscription.activated', payload: {} }, 'evt_no_creds');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook/razorpay/nc-rzp-app',
      headers,
      payload,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_NOT_CONFIGURED');
  });

  // ---------- idempotency ----------

  it('processes an event once, marks duplicate replays as already-seen', async () => {
    const sub = await seedPendingSub('sub_idempo', 'sub_idempo');
    const evt = {
      event: 'subscription.activated',
      payload: { subscription: { entity: { id: 'sub_idempo', status: 'active' } } },
    };
    const { payload, headers } = signed(evt, 'evt_idempo_1');

    const first = await app.inject({ method: 'POST', url: URL, headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ received: true, processed: true });

    const second = await app.inject({ method: 'POST', url: URL, headers, payload });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ received: true, processed: false, reason: 'duplicate' });

    const rows = await prisma.webhookEvent.findMany({ where: { providerEventId: 'evt_idempo_1' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processedAt).not.toBeNull();
    void sub;
  });

  // ---------- state machine ----------

  async function seedPendingSub(checkoutSessionId: string, _label: string): Promise<{ id: string }> {
    const plan = await prisma.plan.findUniqueOrThrow({
      where: { applicationId_slug: { applicationId, slug: 'pro_monthly' } },
    });
    const endUser = await prisma.endUser.create({
      data: { applicationId, email: `rzp-${checkoutSessionId}@example.com`, mode: 'TEST' },
    });
    return prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId: plan.id,
        provider: 'razorpay',
        status: 'PENDING',
        mode: 'TEST',
        metadata: { checkoutSessionId },
      },
      select: { id: true },
    });
  }

  it('subscription.activated: PENDING → ACTIVE, persists providerSubId', async () => {
    const sub = await seedPendingSub('sub_act_1', 'act');
    const evt = {
      event: 'subscription.activated',
      payload: { subscription: { entity: { id: 'sub_act_1', status: 'active', current_end: 1893456000 } } },
    };
    const { payload, headers } = signed(evt, 'evt_act_1');
    const res = await app.inject({ method: 'POST', url: URL, headers, payload });
    expect(res.statusCode).toBe(200);

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.providerSubId).toBe('sub_act_1');
  });

  it('subscription.charged: inserts a SUCCEEDED Payment, keeps Subscription ACTIVE', async () => {
    const sub = await seedPendingSub('sub_chg_1', 'chg');
    // Activate first so providerSubId is set.
    {
      const evt = {
        event: 'subscription.activated',
        payload: { subscription: { entity: { id: 'sub_chg_1', status: 'active' } } },
      };
      const { payload, headers } = signed(evt, 'evt_chg_act');
      await app.inject({ method: 'POST', url: URL, headers, payload });
    }
    const evt = {
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: 'sub_chg_1', status: 'active', paid_count: 2, current_end: 1893456000 } },
        payment: { entity: { id: 'pay_chg_1', amount: 49900, currency: 'INR' } },
      },
    };
    const { payload, headers } = signed(evt, 'evt_chg_1');
    await app.inject({ method: 'POST', url: URL, headers, payload });

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('ACTIVE');

    const payment = await prisma.payment.findUniqueOrThrow({ where: { providerPaymentId: 'pay_chg_1' } });
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.amount).toBe(49900);
    expect(payment.currency).toBe('INR');
    expect(payment.subscriptionId).toBe(sub.id);
  });

  it('subscription.activated → charged: recurring CREDIT plan grants once at activation, refills on next charge', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { slug: 'credit_pack', name: 'Credits', amount: 19900 },
    });
    const plan = await prisma.plan.findUniqueOrThrow({
      where: { applicationId_slug: { applicationId, slug: 'credit_pack' } },
    });
    await prisma.planEntitlement.create({ data: { planId: plan.id, kind: 'CREDIT', key: '', quantity: 500 } });
    const endUser = await prisma.endUser.create({
      data: { applicationId, email: 'rzp-credit@example.com', mode: 'TEST' },
    });
    await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId: plan.id,
        provider: 'razorpay',
        status: 'PENDING',
        mode: 'TEST',
        metadata: { checkoutSessionId: 'sub_credit' },
      },
    });

    // activation → first grant (anchor 'initial').
    {
      const evt = {
        event: 'subscription.activated',
        payload: { subscription: { entity: { id: 'sub_credit', status: 'active' } } },
      };
      const { payload, headers } = signed(evt, 'evt_credit_act');
      await app.inject({ method: 'POST', url: URL, headers, payload });
    }
    expect(await creditsService.getBalance(applicationId, { endUserId: endUser.id })).toBe(500);

    // first charge (paid_count 1) collides with the activation grant — no double.
    {
      const evt = {
        event: 'subscription.charged',
        payload: {
          subscription: { entity: { id: 'sub_credit', status: 'active', paid_count: 1 } },
          payment: { entity: { id: 'pay_credit_1', amount: 19900, currency: 'INR' } },
        },
      };
      const { payload, headers } = signed(evt, 'evt_credit_chg1');
      await app.inject({ method: 'POST', url: URL, headers, payload });
    }
    expect(await creditsService.getBalance(applicationId, { endUserId: endUser.id })).toBe(500);

    // period advances; next charge (paid_count 2) refills a fresh 500.
    await prisma.subscription.update({
      where: { providerSubId: 'sub_credit' },
      data: { currentPeriodEnd: new Date('2026-08-31T00:00:00.000Z') },
    });
    {
      const evt = {
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: { id: 'sub_credit', status: 'active', paid_count: 2, current_end: 1788000000 },
          },
          payment: { entity: { id: 'pay_credit_2', amount: 19900, currency: 'INR' } },
        },
      };
      const { payload, headers } = signed(evt, 'evt_credit_chg2');
      await app.inject({ method: 'POST', url: URL, headers, payload });
    }
    expect(await creditsService.getBalance(applicationId, { endUserId: endUser.id })).toBe(1000);
  });

  it('subscription.cancelled: → CANCELED with canceledAt', async () => {
    const sub = await seedPendingSub('sub_cancel', 'cancel');
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'ACTIVE', providerSubId: 'sub_cancel' },
    });
    const evt = {
      event: 'subscription.cancelled',
      created_at: 1893456000,
      payload: { subscription: { entity: { id: 'sub_cancel', status: 'cancelled' } } },
    };
    const { payload, headers } = signed(evt, 'evt_cancel_1');
    await app.inject({ method: 'POST', url: URL, headers, payload });

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('CANCELED');
    expect(after.canceledAt).not.toBeNull();
  });

  it('subscription.halted: → PAST_DUE', async () => {
    const sub = await seedPendingSub('sub_halt', 'halt');
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'ACTIVE', providerSubId: 'sub_halt' },
    });
    const evt = {
      event: 'subscription.halted',
      payload: { subscription: { entity: { id: 'sub_halt', status: 'halted' } } },
    };
    const { payload, headers } = signed(evt, 'evt_halt_1');
    await app.inject({ method: 'POST', url: URL, headers, payload });

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('PAST_DUE');
  });

  it('payment_link.paid: one-off purchase → ACTIVE + SUCCEEDED Payment', async () => {
    const plan = await prisma.plan.findUniqueOrThrow({
      where: { applicationId_slug: { applicationId, slug: 'pro_monthly' } },
    });
    const endUser = await prisma.endUser.create({
      data: { applicationId, email: 'rzp-link@example.com', mode: 'TEST' },
    });
    const sub = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId: plan.id,
        provider: 'razorpay',
        status: 'PENDING',
        mode: 'TEST',
        metadata: { checkoutSessionId: 'plink_1', oneTime: true },
      },
    });
    const evt = {
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: 'plink_1' } },
        payment: { entity: { id: 'pay_link_1', amount: 49900, currency: 'INR' } },
      },
    };
    const { payload, headers } = signed(evt, 'evt_link_1');
    await app.inject({ method: 'POST', url: URL, headers, payload });

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('ACTIVE');
    const payment = await prisma.payment.findUniqueOrThrow({ where: { providerPaymentId: 'pay_link_1' } });
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.amount).toBe(49900);
  });

  it('unhandled event types are recorded but not processed (200 OK)', async () => {
    const evt = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x' } } } };
    const { payload, headers } = signed(evt, 'evt_unhandled');
    const res = await app.inject({ method: 'POST', url: URL, headers, payload });
    expect(res.statusCode).toBe(200);
    const row = await prisma.webhookEvent.findUniqueOrThrow({
      where: { provider_providerEventId: { provider: 'razorpay', providerEventId: 'evt_unhandled' } },
    });
    expect(row.processedAt).not.toBeNull();
    expect(row.processingError).toBeNull();
  });
});
