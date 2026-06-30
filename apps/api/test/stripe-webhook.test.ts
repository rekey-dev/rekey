/**
 * Stripe webhook ingestion — signature verification, durable idempotency,
 * state-machine transitions.
 *
 * We don't need a real Stripe account: `stripe.webhooks.generateTestHeaderString`
 * builds the signature offline using the same HMAC the verifier checks.
 * That makes the whole flow exercisable in CI.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { creditsService } from '../src/modules/credits/credits.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const SLUG = 'w-app';
// Per-app BYO webhook secret. There is no deployment-wide STRIPE_WEBHOOK_SECRET
// anymore — webhooks are per-Application only.
const WEBHOOK_SECRET = 'whsec_test_secret_for_ci_only';

const stripe = new Stripe('sk_for_signing_only', {
  apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
});

function signedRequest(body: object): { payload: string; headers: Record<string, string> } {
  const payload = JSON.stringify(body);
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return {
    payload,
    headers: {
      'stripe-signature': sig,
      'content-type': 'application/json',
    },
  };
}

describe('POST /api/v1/billing/webhook/stripe/:slug', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;
  let endUserAccessToken: string;

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
        payload: { name: 'WT', ownerEmail: 'wt@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'WApp', slug: SLUG, enableBilling: true },
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

    // BYO Stripe creds (incl. webhook signing secret) so the per-app webhook
    // endpoint resolves + verifies against this app's own secret.
    await billingCredentialsService.upsertStripe(
      applicationId,
      { apiKey: 'sk_test_for_ci_only', webhookSecret: WEBHOOK_SECRET },
      { enabled: true, mode: 'test' },
    );

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
      payload: { email: 'webhook-user@example.com', password: 'pw-one-two-three' },
    });
    endUserAccessToken = (su.json().data as { accessToken: string }).accessToken;
  }

  beforeEach(async () => {
    await bootstrap();
  });

  // ---------- signature ----------

  it('rejects requests with no stripe-signature header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${SLUG}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('WEBHOOK_SIGNATURE_MISSING');
  });

  it('rejects requests with a forged signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${SLUG}`,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=1,v1=deadbeef',
      },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  // ---------- idempotency ----------

  it('processes an event once, marks duplicate replays as already-seen', async () => {
    const evt = {
      id: 'evt_idempo_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_x', metadata: { applicationId } } },
    };
    const { payload, headers } = signedRequest(evt);

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${SLUG}`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ received: true, processed: true });

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${SLUG}`,
      headers,
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ received: true, processed: false, reason: 'duplicate' });

    const rows = await prisma.webhookEvent.findMany({ where: { providerEventId: 'evt_idempo_1' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processedAt).not.toBeNull();
  });

  it('refuses (503) when the slug has no Stripe webhook secret configured', async () => {
    // Separate app with no billing credentials.
    const t = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'NoCreds', ownerEmail: 'nc-stripe@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { tenantId: t.id, name: 'NoCredsApp', slug: 'nc-stripe-app' },
    });
    const evt = {
      id: 'evt_no_creds',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_y', metadata: {} } },
    };
    const { payload, headers } = signedRequest(evt);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook/stripe/nc-stripe-app',
      headers,
      payload,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_NOT_CONFIGURED');
  });

  // ---------- state machine ----------

  it('checkout.session.completed: PENDING subscription → ACTIVE; persists providerSubId', async () => {
    // 1. Create a real PENDING subscription via /checkout.
    const checkout = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: {
        authorization: `Bearer ${liveKey}`,
        'x-relipay-user-token': endUserAccessToken,
      },
      payload: {
        planSlug: 'pro_monthly',
        successUrl: 'https://x.example/ok',
        cancelUrl: 'https://x.example/cancel',
      },
    });
    const subscription = (checkout.json().data as { subscription: { id: string; metadata: { checkoutSessionId: string } } })
      .subscription;
    const checkoutSessionId = subscription.metadata.checkoutSessionId;

    // 2. Synthesise the matching Stripe event.
    const evt = {
      id: 'evt_complete_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: checkoutSessionId,
          subscription: 'sub_remote_xyz',
          metadata: { applicationId },
        },
      },
    };
    const { payload, headers } = signedRequest(evt);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${SLUG}`,
      headers,
      payload,
    });
    expect(res.statusCode).toBe(200);

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.providerSubId).toBe('sub_remote_xyz');
  });

  it('invoice.paid: inserts a SUCCEEDED Payment, ensures Subscription is ACTIVE', async () => {
    // Bootstrap: create a subscription locally with a known providerSubId
    // (sidesteps having to run two webhooks back-to-back).
    const plan = await prisma.plan.findUniqueOrThrow({
      where: { applicationId_slug: { applicationId, slug: 'pro_monthly' } },
    });
    const endUser = await prisma.endUser.findFirstOrThrow({ where: { applicationId } });
    const sub = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId: plan.id,
        status: 'PENDING',
        providerSubId: 'sub_invoice_test',
      },
    });

    const evt = {
      id: 'evt_invoice_paid',
      object: 'event',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_test_paid',
          subscription: 'sub_invoice_test',
          amount_paid: 999,
          currency: 'usd',
          metadata: { applicationId },
        },
      },
    };
    const { payload, headers } = signedRequest(evt);
    await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${SLUG}`,
      headers,
      payload,
    });

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('ACTIVE');

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { providerPaymentId: 'in_test_paid' },
    });
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.amount).toBe(999);
    expect(payment.currency).toBe('USD');
    expect(payment.subscriptionId).toBe(sub.id);
  });

  it('invoice.paid: re-provisions entitlements on renewal — recurring CREDIT plan refills credits each period', async () => {
    // A plan that grants 500 credits per period via an explicit CREDIT
    // entitlement (the admin plans route only takes slug/name/amount, so the
    // bundle is attached directly — same shape the tenant entitlement route writes).
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { slug: 'credit_pack', name: 'Credits', amount: 1900 },
    });
    const plan = await prisma.plan.findUniqueOrThrow({
      where: { applicationId_slug: { applicationId, slug: 'credit_pack' } },
    });
    await prisma.planEntitlement.create({
      data: { planId: plan.id, kind: 'CREDIT', key: '', quantity: 500 },
    });
    const endUser = await prisma.endUser.findFirstOrThrow({ where: { applicationId } });

    // An ACTIVE subscription whose first period ends at p1.
    const p1 = new Date('2026-01-31T00:00:00.000Z');
    const sub = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId: plan.id,
        status: 'ACTIVE',
        providerSubId: 'sub_renewal_test',
        currentPeriodEnd: p1,
      },
    });

    const fireInvoicePaid = async (eventId: string, invoiceId: string): Promise<void> => {
      const evt = {
        id: eventId,
        object: 'event',
        type: 'invoice.paid',
        data: {
          object: {
            id: invoiceId,
            subscription: 'sub_renewal_test',
            amount_paid: 1900,
            currency: 'usd',
            metadata: { applicationId },
          },
        },
      };
      const { payload, headers } = signedRequest(evt);
      await app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/stripe/${SLUG}`,
        headers,
        payload,
      });
    };

    // First period's invoice → 500 credits granted.
    await fireInvoicePaid('evt_renew_p1', 'in_renew_p1');
    expect(await creditsService.getBalance(applicationId, { endUserId: endUser.id })).toBe(500);

    // A replayed invoice in the SAME period must NOT double-grant (per-period
    // idempotency anchor keyed off currentPeriodEnd).
    await fireInvoicePaid('evt_renew_p1_replay', 'in_renew_p1_replay');
    expect(await creditsService.getBalance(applicationId, { endUserId: endUser.id })).toBe(500);

    // Stripe advances the period (customer.subscription.updated) → new period p2.
    const p2 = new Date('2026-02-28T00:00:00.000Z');
    await prisma.subscription.update({ where: { id: sub.id }, data: { currentPeriodEnd: p2 } });

    // Next period's renewal invoice → a FRESH 500 credits (1000 total).
    await fireInvoicePaid('evt_renew_p2', 'in_renew_p2');
    expect(await creditsService.getBalance(applicationId, { endUserId: endUser.id })).toBe(1000);
  });

  it('first period is granted ONCE even if subscription.updated lands before the first invoice.paid (no double-grant)', async () => {
    // Regression: the per-period idempotency anchor keys off `currentPeriodEnd`.
    // checkout.session.completed provisions while it's still null (anchor
    // "…:CREDIT:initial"); Stripe does NOT guarantee webhook ordering, so
    // customer.subscription.updated (which sets currentPeriodEnd) can arrive
    // BEFORE the FIRST invoice.paid. If it does, that first invoice would
    // provision under a DIFFERENT anchor ("…:CREDIT:<p1>") for the SAME first
    // billing period — granting a second pack the buyer never paid for. The fix
    // pins the first invoice (billing_reason: subscription_create) to the
    // 'initial' anchor so it collides with the checkout grant.
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { slug: 'credit_pack_ord', name: 'Credits Ord', amount: 1900 },
    });
    const plan = await prisma.plan.findUniqueOrThrow({
      where: { applicationId_slug: { applicationId, slug: 'credit_pack_ord' } },
    });
    await prisma.planEntitlement.create({
      data: { planId: plan.id, kind: 'CREDIT', key: '', quantity: 500 },
    });
    const endUser = await prisma.endUser.findFirstOrThrow({ where: { applicationId } });

    // A PENDING sub created at checkout — currentPeriodEnd is null, exactly as
    // billing.service writes it. Its checkoutSessionId is what the completed
    // event matches on.
    const sub = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId: plan.id,
        status: 'PENDING',
        providerSubId: 'sub_order_test',
        metadata: { checkoutSessionId: 'cs_order_test' },
      },
    });

    const fire = async (
      eventId: string,
      type: string,
      object: Record<string, unknown>,
    ): Promise<void> => {
      const evt = { id: eventId, object: 'event', type, data: { object } };
      const { payload, headers } = signedRequest(evt);
      await app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/stripe/${SLUG}`,
        headers,
        payload,
      });
    };

    const p1 = Math.floor(new Date('2026-06-30T00:00:00.000Z').getTime() / 1000);

    // 1) checkout.session.completed → ACTIVE + first grant (period "initial").
    await fire('evt_ord_complete', 'checkout.session.completed', {
      id: 'cs_order_test',
      subscription: 'sub_order_test',
      metadata: { applicationId },
    });
    expect(await creditsService.getBalance(applicationId, { endUserId: endUser.id })).toBe(500);

    // 2) customer.subscription.updated arrives FIRST (out of order) → sets the
    //    first period's end.
    await fire('evt_ord_updated', 'customer.subscription.updated', {
      id: 'sub_order_test',
      status: 'active',
      current_period_end: p1,
      metadata: { applicationId },
    });

    // 3) The FIRST invoice.paid (subscription_create) pays for that very first
    //    period → must NOT grant a second pack. The buyer paid for ONE period.
    await fire('evt_ord_invoice', 'invoice.paid', {
      id: 'in_order_first',
      subscription: 'sub_order_test',
      amount_paid: 1900,
      currency: 'usd',
      billing_reason: 'subscription_create',
      metadata: { applicationId },
    });
    expect(await creditsService.getBalance(applicationId, { endUserId: endUser.id })).toBe(500);

    // 4) A genuine renewal (subscription_cycle) for the NEXT period still
    //    refills — proves the fix doesn't over-suppress legitimate grants.
    const p2 = Math.floor(new Date('2026-07-31T00:00:00.000Z').getTime() / 1000);
    await fire('evt_ord_updated_p2', 'customer.subscription.updated', {
      id: 'sub_order_test',
      status: 'active',
      current_period_end: p2,
      metadata: { applicationId },
    });
    await fire('evt_ord_invoice_p2', 'invoice.paid', {
      id: 'in_order_renew',
      subscription: 'sub_order_test',
      amount_paid: 1900,
      currency: 'usd',
      billing_reason: 'subscription_cycle',
      metadata: { applicationId },
    });
    expect(await creditsService.getBalance(applicationId, { endUserId: endUser.id })).toBe(1000);
    void sub;
  });

  it('invoice.paid: re-provisions a TIMED license — extends expiry on renewal, idempotent within a period (#73)', async () => {
    // A recurring TIMED LICENSE plan (30-day term). Inserted directly — the
    // admin plans route only accepts SUBSCRIPTION fields.
    const plan = await prisma.plan.create({
      data: {
        applicationId,
        slug: 'timed_lic',
        name: 'Timed License',
        amount: 1999,
        currency: 'USD',
        kind: 'LICENSE',
        licenseKind: 'TIMED',
        licenseDurationDays: 30,
        interval: 'MONTH',
      },
    });
    const endUser = await prisma.endUser.findFirstOrThrow({ where: { applicationId } });
    const p1 = new Date('2026-03-31T00:00:00.000Z');
    await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId: plan.id,
        status: 'ACTIVE',
        providerSubId: 'sub_timed_lic',
        currentPeriodEnd: p1,
      },
    });

    const fireInvoicePaid = async (eventId: string, invoiceId: string): Promise<void> => {
      const evt = {
        id: eventId,
        object: 'event',
        type: 'invoice.paid',
        data: {
          object: {
            id: invoiceId,
            subscription: 'sub_timed_lic',
            amount_paid: 1999,
            currency: 'usd',
            metadata: { applicationId },
          },
        },
      };
      const { payload, headers } = signedRequest(evt);
      await app.inject({ method: 'POST', url: `/api/v1/billing/webhook/stripe/${SLUG}`, headers, payload });
    };

    // First period's invoice → license issued with a ~30-day term.
    await fireInvoicePaid('evt_lic_p1', 'in_lic_p1');
    const lic1 = await prisma.license.findFirstOrThrow({
      where: { applicationId, endUserId: endUser.id, planId: plan.id },
    });
    expect(lic1.kind).toBe('TIMED');
    const expiry1 = lic1.expiresAt!.getTime();

    // Replay within the SAME period → no second extension (anchored on period).
    await fireInvoicePaid('evt_lic_p1_replay', 'in_lic_p1_replay');
    const licReplay = await prisma.license.findUniqueOrThrow({ where: { id: lic1.id } });
    expect(licReplay.expiresAt!.getTime()).toBe(expiry1);

    // Period advances (subscription.updated) → next invoice extends by ~30 days.
    const p2 = new Date('2026-04-30T00:00:00.000Z');
    await prisma.subscription.update({ where: { providerSubId: 'sub_timed_lic' }, data: { currentPeriodEnd: p2 } });
    await fireInvoicePaid('evt_lic_p2', 'in_lic_p2');
    const lic2 = await prisma.license.findUniqueOrThrow({ where: { id: lic1.id } });
    const delta = lic2.expiresAt!.getTime() - expiry1;
    expect(delta).toBeGreaterThan(29 * 86_400_000);
    expect(delta).toBeLessThan(31 * 86_400_000);
    expect(lic2.status).toBe('ACTIVE');

    // Still exactly one license row — extension never over-issues.
    const count = await prisma.license.count({
      where: { applicationId, endUserId: endUser.id, planId: plan.id },
    });
    expect(count).toBe(1);
  });

  it('invoice.payment_failed: inserts a FAILED Payment, sets Subscription PAST_DUE', async () => {
    const plan = await prisma.plan.findUniqueOrThrow({
      where: { applicationId_slug: { applicationId, slug: 'pro_monthly' } },
    });
    const endUser = await prisma.endUser.findFirstOrThrow({ where: { applicationId } });
    const sub = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId: plan.id,
        status: 'ACTIVE',
        providerSubId: 'sub_will_fail',
      },
    });

    const evt = {
      id: 'evt_invoice_fail',
      object: 'event',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_test_fail',
          subscription: 'sub_will_fail',
          amount_due: 999,
          currency: 'usd',
          metadata: { applicationId },
        },
      },
    };
    const { payload, headers } = signedRequest(evt);
    await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${SLUG}`,
      headers,
      payload,
    });

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('PAST_DUE');

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { providerPaymentId: 'in_test_fail' },
    });
    expect(payment.status).toBe('FAILED');
  });

  it('customer.subscription.deleted: → CANCELED with canceledAt timestamp', async () => {
    const plan = await prisma.plan.findUniqueOrThrow({
      where: { applicationId_slug: { applicationId, slug: 'pro_monthly' } },
    });
    const endUser = await prisma.endUser.findFirstOrThrow({ where: { applicationId } });
    const sub = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId: plan.id,
        status: 'ACTIVE',
        providerSubId: 'sub_to_cancel',
      },
    });
    const cancelTime = Math.floor(Date.now() / 1000);

    const evt = {
      id: 'evt_sub_deleted',
      object: 'event',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_to_cancel',
          status: 'canceled',
          canceled_at: cancelTime,
          metadata: { applicationId },
        },
      },
    };
    const { payload, headers } = signedRequest(evt);
    await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${SLUG}`,
      headers,
      payload,
    });

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('CANCELED');
    expect(after.canceledAt).not.toBeNull();
  });

  it('unhandled event types are recorded but not processed (200 OK)', async () => {
    const evt = {
      id: 'evt_unhandled',
      object: 'event',
      type: 'customer.tax_id.created',
      data: { object: { id: 'txi_1', metadata: { applicationId } } },
    };
    const { payload, headers } = signedRequest(evt);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${SLUG}`,
      headers,
      payload,
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.webhookEvent.findUniqueOrThrow({
      where: { provider_providerEventId: { provider: 'stripe', providerEventId: 'evt_unhandled' } },
    });
    expect(row.processedAt).not.toBeNull();
    expect(row.processingError).toBeNull();
  });
});
