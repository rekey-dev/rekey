/**
 * Razorpay on the Rekey-hosted checkout page, recurring and one-time.
 *
 * Creation hands the page a browser config with no secret in it; the page's
 * "paid" is checked against Razorpay's signature (and, for an order, Razorpay's
 * record of the payment) and moves the session to CONFIRMING only; the
 * purchase completes from Razorpay's webhook alone, once. Runs with the fake
 * Razorpay provider, whose `payments` map is Razorpay's side of each payment.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { creditsService } from '../src/modules/credits/credits.service.js';
import { configureSandboxPaypal, configureSandboxRazorpay, RAZORPAY_TEST_KEY_SECRET } from './fakes/billing-credentials.js';
import { fakeRazorpay } from './fakes/billing-providers.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';
import { MAX_REFUSED_CONFIRMATIONS } from '../src/modules/billing/checkout/confirm-approval.js';
import { browserCredentialCheck, providerCheck, webhookCheck } from '../src/modules/billing/checkout/readiness.js';

const PASSWORD = 'pw-one-two-three';
const REGISTERED = 'https://app.example';
const PORTAL = new URL(process.env.PUBLIC_PORTAL_URL!).origin;
const PROBE_OK = { status: 'PASS', message: 'ok', fix: null, cspReports: true, at: new Date().toISOString() };
const WEBHOOK_SECRET = 'rzp_whsec_ci_only';
const SUB_PRICE = 49900;
const PACK_PRICE = 19900;
const PACK_CREDITS = 100;

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function paymentId(): string {
  return `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
}

describe('Razorpay on the checkout page', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let slug: string;
  let liveKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"cspReports":true}', { status: 200 }));
    fakeRazorpay.payments.clear();
    fakeRazorpay.captured.length = 0;
    slug = `rzp-${Math.random().toString(36).slice(2, 8)}`;
    const operatorAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const auth = { authorization: `Bearer ${operatorAccess}` };
    applicationId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: auth, payload: { name: `App ${slug}`, slug, enableBilling: true } })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({ method: 'POST', url: `/api/v1/tenant/applications/${applicationId}/api-keys`, headers: auth, payload: { name: 'k', mode: 'live' } })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await configureSandboxRazorpay(applicationId, WEBHOOK_SECRET);
    for (const payload of [
      { slug: 'standard', name: 'Standard', amount: SUB_PRICE, currency: 'INR' },
      { slug: 'pack', name: '100 credits', amount: PACK_PRICE, currency: 'INR', kind: 'CREDIT', creditsAmount: PACK_CREDITS },
    ]) {
      const res = await app.inject({ method: 'POST', url: `/api/v1/tenant/applications/${applicationId}/plans`, headers: auth, payload });
      expect(res.statusCode, res.body).toBeLessThan(300);
    }
    const current = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        authConfig: { ...(current.authConfig as Prisma.JsonObject), appUrl: `${REGISTERED}/account` },
        checkoutModeTest: 'EMBEDDED',
        checkoutModeLive: 'EMBEDDED',
        checkoutReadiness: { probe: PROBE_OK },
      },
    });
  });

  async function buyer(): Promise<string> {
    return app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${randomUUID()}@example.com`, password: PASSWORD },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
  }

  function checkoutAs(userAccess: string, planSlug: 'standard' | 'pack') {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
      payload: { planSlug, successUrl: `${REGISTERED}/account?paid=1`, cancelUrl: `${REGISTERED}/account` },
    });
  }

  async function startCheckout(planSlug: 'standard' | 'pack', userAccess?: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess ?? (await buyer()) },
      payload: { planSlug, successUrl: `${REGISTERED}/account?paid=1`, cancelUrl: `${REGISTERED}/account` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as { url: string; mode: string; checkoutSessionId: string };
    expect(data.mode).toBe('embedded');
    const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: data.checkoutSessionId } });
    return { token: data.url.split('/').pop()!, providerId: row.providerSessionId, sessionId: row.id, subscriptionId: row.subscriptionId };
  }

  function subscriptionApproval(subscriptionId: string, pay = paymentId(), signature?: string) {
    return { paymentId: pay, subscriptionId, signature: signature ?? hmac(RAZORPAY_TEST_KEY_SECRET, `${pay}|${subscriptionId}`) };
  }

  function orderApproval(orderId: string, pay = paymentId(), signature?: string) {
    return { paymentId: pay, orderId, signature: signature ?? hmac(RAZORPAY_TEST_KEY_SECRET, `${orderId}|${pay}`) };
  }

  function paidAtRazorpay(pay: string, orderId: string, patch: Partial<{ status: string; amount: number; currency: string; orderId: string }> = {}) {
    fakeRazorpay.payments.set(pay, { id: pay, status: 'captured', orderId, amount: PACK_PRICE, currency: 'INR', ...patch });
  }

  function approve(token: string, body: Record<string, string>, headers: Record<string, string> = {}) {
    return app.inject({ method: 'POST', url: `/api/v1/checkout-sessions/${token}/razorpay/approved`, headers, payload: body });
  }

  function webhook(body: object) {
    const payload = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/razorpay/${slug}`,
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': hmac(WEBHOOK_SECRET, payload) },
      payload,
    });
  }

  function orderPaid(orderId: string, pay: string, createdAt = 1_790_000_000, notes: object = { rekey_checkout: 'embedded' }) {
    return {
      event: 'order.paid',
      created_at: createdAt,
      payload: {
        order: { entity: { id: orderId, notes, status: 'paid', amount: PACK_PRICE, amount_paid: PACK_PRICE } },
        payment: { entity: { id: pay, amount: PACK_PRICE, currency: 'INR', status: 'captured', order_id: orderId } },
      },
    };
  }

  async function sessionRow(id: string) {
    return prisma.checkoutSession.findUniqueOrThrow({ where: { id }, include: { subscription: true } });
  }

  async function refusalReasons(atLeast = 1): Promise<string[]> {
    const events = await waitForSecurityEvents({ applicationId, type: 'app.checkout_confirmation_refused' }, { atLeast });
    return events.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((e) => (e.metadata as { reason: string }).reason);
  }

  describe('creation', () => {
    it('creates a subscription and hands the page its id, the key id and nothing secret', async () => {
      const { token, providerId } = await startCheckout('standard');
      expect(providerId).toMatch(/^sub_/);
      expect(fakeRazorpay.lastEmbedded?.kind).toBe('recurring');
      expect(fakeRazorpay.lastEmbedded?.returnUrl).toContain(`/checkout/${token}`);
      const res = await app.inject({ method: 'GET', url: `/api/v1/checkout-sessions/${token}` });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data.order.client).toEqual({
        provider: 'razorpay',
        keyId: 'rzp_test_ci',
        sdk: 'razorpay-checkout',
        target: { kind: 'subscription', subscriptionId: providerId },
      });
      expect(res.json().data.provider).toBe('razorpay');
      expect(res.body).not.toContain(RAZORPAY_TEST_KEY_SECRET);
      expect(res.body).not.toContain(WEBHOOK_SECRET);
      const fallback = await app.inject({ method: 'POST', url: `/api/v1/checkout-sessions/${token}/fallback` });
      expect(fallback.json().data.url).toMatch(/^https:\/\/rzp\.io\//);
    });

    it('creates an order for a one-time purchase, with no link to fall back to', async () => {
      const { token, providerId } = await startCheckout('pack');
      expect(providerId).toMatch(/^order_/);
      expect(fakeRazorpay.lastEmbedded?.kind).toBe('one_time');
      const res = await app.inject({ method: 'GET', url: `/api/v1/checkout-sessions/${token}` });
      expect(res.json().data.order.client).toEqual({ provider: 'razorpay', keyId: 'rzp_test_ci', sdk: 'razorpay-checkout', target: { kind: 'order', orderId: providerId } });
      expect(res.json().data.order.plan.kind).toBe('one_time');
      const fallback = await app.inject({ method: 'POST', url: `/api/v1/checkout-sessions/${token}/fallback` });
      expect(fallback.statusCode).toBe(409);
      expect(fallback.json().error.code).toBe('CHECKOUT_FALLBACK_UNAVAILABLE');
    });
  });

  describe('approval', () => {
    it('moves a signed subscription payment to CONFIRMING and activates nothing', async () => {
      const { token, providerId, sessionId } = await startCheckout('standard');
      const res = await approve(token, subscriptionApproval(providerId));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toEqual({ status: 'confirming' });
      const row = await sessionRow(sessionId);
      expect(row.status).toBe('CONFIRMING');
      expect(row.subscription.status).toBe('PENDING');
    });

    it('moves a signed, captured order payment to CONFIRMING without capturing it again', async () => {
      const { token, providerId, sessionId } = await startCheckout('pack');
      const body = orderApproval(providerId);
      paidAtRazorpay(body.paymentId, providerId);
      expect((await approve(token, body)).json().data).toEqual({ status: 'confirming' });
      expect((await sessionRow(sessionId)).subscription.status).toBe('PENDING');
      expect(fakeRazorpay.captured).toEqual([]);
    });

    it('captures an order payment Razorpay only authorized, so order.paid can arrive', async () => {
      const { token, providerId } = await startCheckout('pack');
      const body = orderApproval(providerId);
      paidAtRazorpay(body.paymentId, providerId, { status: 'authorized' });
      expect((await approve(token, body)).json().data).toEqual({ status: 'confirming' });
      expect(fakeRazorpay.captured).toEqual([{ id: body.paymentId, amount: PACK_PRICE, currency: 'INR' }]);
    });

    it('refuses a forged signature', async () => {
      const { token, providerId, sessionId } = await startCheckout('standard');
      const res = await approve(token, subscriptionApproval(providerId, paymentId(), hmac('not-the-secret', 'x')));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
      expect((await sessionRow(sessionId)).status).toBe('OPEN');
      expect(await refusalReasons()).toEqual(['signature_invalid']);
    });

    it('refuses a signature over the payload in the wrong order', async () => {
      const sub = await startCheckout('standard');
      const pay = paymentId();
      const swappedSub = await approve(sub.token, subscriptionApproval(sub.providerId, pay, hmac(RAZORPAY_TEST_KEY_SECRET, `${sub.providerId}|${pay}`)));
      expect(swappedSub.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');

      const order = await startCheckout('pack');
      const orderPay = paymentId();
      paidAtRazorpay(orderPay, order.providerId);
      const swappedOrder = await approve(order.token, orderApproval(order.providerId, orderPay, hmac(RAZORPAY_TEST_KEY_SECRET, `${orderPay}|${order.providerId}`)));
      expect(swappedOrder.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
      expect(await refusalReasons(2)).toEqual(['signature_invalid', 'signature_invalid']);
    });

    it("refuses another checkout's id, even with a valid signature for it", async () => {
      const mine = await startCheckout('standard');
      const theirs = await startCheckout('standard');
      const res = await approve(mine.token, subscriptionApproval(theirs.providerId));
      expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
      expect((await sessionRow(mine.sessionId)).status).toBe('OPEN');
      expect(await refusalReasons()).toEqual(['subscription_id_mismatch']);
    });

    it('refuses an order id on a subscription checkout', async () => {
      const { token, providerId } = await startCheckout('standard');
      const res = await approve(token, orderApproval(providerId.replace(/^sub_/, 'order_')));
      expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
      expect(await refusalReasons()).toEqual(['kind_mismatch']);
    });

    it.each([
      ['a payment Razorpay does not know', null, 'unknown_at_razorpay'],
      ['a payment for another order', { orderId: 'order_someoneelse' }, 'payment_order_mismatch'],
      ['a payment for less than the order', { amount: PACK_PRICE - 1 }, 'amount_mismatch'],
      ['a payment in another currency', { currency: 'USD' }, 'currency_mismatch'],
    ] as const)('refuses %s', async (_label, patch, reason) => {
      const { token, providerId, sessionId } = await startCheckout('pack');
      const body = orderApproval(providerId);
      if (patch !== null) paidAtRazorpay(body.paymentId, providerId, patch);
      const res = await approve(token, body);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
      expect((await sessionRow(sessionId)).status).toBe('OPEN');
      expect(await refusalReasons()).toEqual([reason]);
    });

    it('checks the amount recorded at checkout, not the plan as it is now', async () => {
      const { token, providerId, subscriptionId } = await startCheckout('pack');
      const { planId } = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
      await prisma.plan.update({ where: { id: planId }, data: { amount: PACK_PRICE * 2 } });
      const body = orderApproval(providerId);
      paidAtRazorpay(body.paymentId, providerId);
      expect((await approve(token, body)).json().data).toEqual({ status: 'confirming' });
    });

    it('does not count a checkout Rekey cannot verify against the buyer, and says why', async () => {
      const { token, providerId, sessionId } = await startCheckout('pack');
      const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: sessionId } });
      const { expectedCharge: _dropped, ...meta } = row.metadata as Record<string, unknown>;
      await prisma.checkoutSession.update({ where: { id: sessionId }, data: { metadata: meta as Prisma.InputJsonObject } });
      const body = orderApproval(providerId);
      paidAtRazorpay(body.paymentId, providerId);
      for (let i = 0; i < MAX_REFUSED_CONFIRMATIONS + 1; i++) {
        const res = await approve(token, body);
        expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
        expect(res.json().error.message).toContain('could not check this payment with Razorpay');
      }
      expect((await refusalReasons(MAX_REFUSED_CONFIRMATIONS + 1)).every((r) => r === 'provider_cannot_verify')).toBe(true);
    });

    it('stops accepting confirmations after repeated refusals', async () => {
      const { token, providerId } = await startCheckout('standard');
      for (let i = 0; i < MAX_REFUSED_CONFIRMATIONS; i++) {
        expect((await approve(token, subscriptionApproval(providerId, paymentId(), 'f'.repeat(64)))).json().error.code).toBe(
          'CHECKOUT_CONFIRMATION_REFUSED',
        );
      }
      const res = await approve(token, subscriptionApproval(providerId));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_LIMIT');
    });

    it('does not count a payment still moving at Razorpay toward the limit', async () => {
      const { token, providerId } = await startCheckout('pack');
      const body = orderApproval(providerId);
      paidAtRazorpay(body.paymentId, providerId, { status: 'created' });
      for (let i = 0; i < MAX_REFUSED_CONFIRMATIONS + 2; i++) {
        expect((await approve(token, body)).json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
      }
      paidAtRazorpay(body.paymentId, providerId);
      expect((await approve(token, body)).json().data).toEqual({ status: 'confirming' });
    });

    it("refuses a Razorpay confirmation on another provider's session", async () => {
      const { token, providerId, sessionId } = await startCheckout('standard');
      await configureSandboxPaypal(applicationId);
      await prisma.checkoutSession.update({ where: { id: sessionId }, data: { provider: 'paypal' } });
      const res = await approve(token, subscriptionApproval(providerId));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CHECKOUT_SESSION_EXPIRED');
    });

    it('refuses a confirmation after the credentials moved from test to live', async () => {
      const { token, providerId } = await startCheckout('standard');
      await prisma.billingCredentials.update({
        where: { applicationId_provider: { applicationId, provider: 'razorpay' } },
        data: { mode: 'live' },
      });
      const res = await approve(token, subscriptionApproval(providerId));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CHECKOUT_MODE_MISMATCH');
    });

    it('never moves a session the webhook completed while Razorpay was being asked back to CONFIRMING', async () => {
      const { token, providerId, sessionId } = await startCheckout('pack');
      const body = orderApproval(providerId);
      paidAtRazorpay(body.paymentId, providerId);
      const read = fakeRazorpay.getPayment.bind(fakeRazorpay);
      vi.spyOn(fakeRazorpay, 'getPayment').mockImplementation(async (id) => {
        await prisma.checkoutSession.update({ where: { id: sessionId }, data: { status: 'COMPLETE' } });
        return read(id);
      });
      expect((await approve(token, body)).json().data).toEqual({ status: 'complete' });
      expect((await sessionRow(sessionId)).status).toBe('COMPLETE');
    });

    it('makes one transition out of eight concurrent confirmations', async () => {
      const { token, providerId, sessionId } = await startCheckout('pack');
      const body = orderApproval(providerId);
      paidAtRazorpay(body.paymentId, providerId);
      const results = await Promise.all(Array.from({ length: 8 }, () => approve(token, body)));
      expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
      expect(new Set(results.map((r) => (r.json().data as { status: string }).status))).toEqual(new Set(['confirming']));
      expect((await sessionRow(sessionId)).status).toBe('CONFIRMING');
    });

    it('refuses a cross-site POST and a malformed body', async () => {
      const { token, providerId } = await startCheckout('standard');
      const body = subscriptionApproval(providerId);
      expect((await approve(token, body, { origin: 'https://evil.example' })).statusCode).toBe(403);
      expect((await approve(token, { ...body, orderId: 'order_x' })).statusCode).toBe(400);
      expect((await approve(token, { ...body, signature: 'nothex' })).statusCode).toBe(400);
      expect((await approve(token, { ...body, paymentId: '../../v1/payments' })).statusCode).toBe(400);
      expect((await approve(token, body, { origin: PORTAL })).statusCode).toBe(200);
    });
  });

  describe('a second subscription checkout while the first is paid at Razorpay', () => {
    it.each(['authenticated', 'active', 'pending'])('is refused when Razorpay reports the open one %s', async (status) => {
      const user = await buyer();
      const first = await startCheckout('standard', user);
      fakeRazorpay.subscriptions.set(first.providerId, { id: first.providerId, status, planId: null, customId: null });
      const second = await checkoutAs(user, 'standard');
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('CHECKOUT_PAYMENT_IN_PROGRESS');
      expect((await sessionRow(first.sessionId)).status).toBe('CONFIRMING');
    });

    it('is allowed while the first is only created at Razorpay', async () => {
      const user = await buyer();
      await startCheckout('standard', user);
      expect((await checkoutAs(user, 'standard')).statusCode).toBe(200);
    });

    it('is refused, not guessed, when Razorpay cannot be asked', async () => {
      const user = await buyer();
      await startCheckout('standard', user);
      vi.spyOn(fakeRazorpay, 'getSubscription').mockRejectedValue(new Error('timeout'));
      const second = await checkoutAs(user, 'standard');
      expect(second.statusCode).toBe(503);
      expect(second.json().error.code).toBe('CHECKOUT_PAYMENT_STATUS_UNAVAILABLE');
      expect(second.json().error.message).toContain('Razorpay');
    });
  });

  describe('order.paid', () => {
    it('fulfils an embedded order once: ACTIVE, one payment, credits granted, session COMPLETE', async () => {
      const { token, providerId, sessionId, subscriptionId } = await startCheckout('pack');
      const pay = paymentId();
      expect((await webhook(orderPaid(providerId, pay))).statusCode).toBe(200);
      const row = await sessionRow(sessionId);
      expect(row.status).toBe('COMPLETE');
      expect(row.subscription.status).toBe('ACTIVE');
      const payments = await prisma.payment.findMany({ where: { applicationId, providerPaymentId: pay } });
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({ amount: PACK_PRICE, currency: 'INR', status: 'SUCCEEDED', subscriptionId });
      expect(await creditsService.getBalance(applicationId, { endUserId: row.subscription.endUserId })).toBe(PACK_CREDITS);
      expect((await app.inject({ method: 'GET', url: `/api/v1/checkout-sessions/${token}/status` })).json().data).toEqual({ status: 'complete' });
    });

    it('grants nothing twice on a replay, a re-sent body or eight concurrent deliveries', async () => {
      const { providerId, sessionId } = await startCheckout('pack');
      const pay = paymentId();
      const body = orderPaid(providerId, pay);
      const results = await Promise.all(Array.from({ length: 8 }, () => webhook(body)));
      expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
      expect((await webhook(body)).json()).toMatchObject({ processed: false, reason: 'duplicate' });
      // A distinct delivery for the same payment (another created_at) is a new event, still one grant.
      expect((await webhook(orderPaid(providerId, pay, 1_790_000_999))).statusCode).toBe(200);
      const row = await sessionRow(sessionId);
      expect(await prisma.payment.count({ where: { applicationId, providerPaymentId: pay } })).toBe(1);
      expect(await creditsService.getBalance(applicationId, { endUserId: row.subscription.endUserId })).toBe(PACK_CREDITS);
      expect(await prisma.webhookEvent.count({ where: { applicationId, eventType: 'order.paid' } })).toBe(2);
    });

    it('leaves the order behind a Payment Link to payment_link.paid', async () => {
      const endUser = await prisma.endUser.create({ data: { applicationId, email: `link-${randomUUID()}@example.com` } });
      const plan = await prisma.plan.findUniqueOrThrow({ where: { applicationId_slug: { applicationId, slug: 'pack' } } });
      const sub = await prisma.subscription.create({
        data: { applicationId, endUserId: endUser.id, planId: plan.id, provider: 'razorpay', status: 'PENDING', metadata: { checkoutSessionId: 'plink_race1' } },
      });
      const pay = paymentId();
      expect((await webhook(orderPaid('order_behindlink', pay, 1_790_000_000, { rekey_plan_id: plan.id }))).statusCode).toBe(200);
      expect(await prisma.payment.count({ where: { applicationId, providerPaymentId: pay } })).toBe(0);
      await webhook({
        event: 'payment_link.paid',
        created_at: 1_790_000_001,
        payload: { payment_link: { entity: { id: 'plink_race1' } }, payment: { entity: { id: pay, amount: PACK_PRICE, currency: 'INR' } } },
      });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('ACTIVE');
    });

    it('changes nothing for an embedded order no local row names', async () => {
      const pay = paymentId();
      expect((await webhook(orderPaid('order_nobodys', pay))).statusCode).toBe(200);
      expect(await prisma.payment.count({ where: { applicationId, providerPaymentId: pay } })).toBe(0);
      expect(await prisma.subscription.count({ where: { applicationId, status: 'ACTIVE' } })).toBe(0);
    });

    it('is not applied when the checkout was started in the other payment mode', async () => {
      const { providerId, sessionId } = await startCheckout('pack');
      await prisma.billingCredentials.update({
        where: { applicationId_provider: { applicationId, provider: 'razorpay' } },
        data: { mode: 'live' },
      });
      await webhook(orderPaid(providerId, paymentId()));
      const row = await sessionRow(sessionId);
      expect(row.subscription.status).toBe('PENDING');
      expect(row.status).toBe('EXPIRED');
    });
  });

  describe('readiness', () => {
    it('passes the provider check for both flows', () => {
      const check = providerCheck('razorpay', 'test', new Set(['recurring', 'one_time']), 'DEVELOPMENT', false);
      expect(check.status).toBe('PASS');
    });

    it('fails the provider check for a provider that cannot take the flow on the page', () => {
      const check = providerCheck('external', 'test', new Set(['recurring']), 'DEVELOPMENT', false);
      expect(check).toMatchObject({ id: 'provider', provider: 'external', status: 'FAIL' });
      expect(check.message).toContain('subscriptions');
    });

    it('fails the browser credential check without a key id', () => {
      const check = browserCredentialCheck('razorpay', { keySecret: 's', webhookSecret: 'w' });
      expect(check.status).toBe('FAIL');
      expect(check.fix).toContain('Providers → Razorpay → Edit');
      expect(browserCredentialCheck('razorpay', { keyId: 'rzp_test_ci' }).status).toBe('PASS');
    });

    it('warns until Razorpay has delivered an order.paid, when one-time plans are sold', async () => {
      const creds = { keyId: 'rzp_test_ci', keySecret: 's', webhookSecret: WEBHOOK_SECRET };
      await webhook({ event: 'subscription.charged', created_at: 1, payload: {} });
      const oneTime = new Set(['one_time'] as const);
      const warned = await webhookCheck(applicationId, 'razorpay', 'test', creds, oneTime);
      expect(warned.status).toBe('WARN');
      expect(warned.message).toContain('order.paid');
      expect((await webhookCheck(applicationId, 'razorpay', 'test', creds, new Set(['recurring'] as const))).status).toBe('PASS');
      await webhook(orderPaid('order_unrelated', paymentId(), 2, {}));
      expect((await webhookCheck(applicationId, 'razorpay', 'test', creds, oneTime)).status).toBe('PASS');
    });

    it('tells an operator with no Razorpay webhook to make one in the Razorpay dashboard', async () => {
      const check = await webhookCheck(applicationId, 'razorpay', 'test', { keyId: 'rzp_test_ci' }, new Set(['recurring'] as const));
      expect(check.status).toBe('FAIL');
      expect(check.fix).toContain('Razorpay Dashboard → Settings → Webhooks');
      expect(check.fix).not.toContain('Auto-configure');
    });
  });
});
