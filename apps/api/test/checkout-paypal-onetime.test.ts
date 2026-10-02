/**
 * PayPal one-time purchases on the Rekey-hosted checkout page: the order is
 * created server-side, the page's "approved" is checked against PayPal's own
 * record of the order and moves the session to CONFIRMING only, and the
 * capture and fulfilment come from PayPal's CHECKOUT.ORDER.APPROVED webhook
 * alone. Runs with the fake PayPal provider, whose `orders` map is PayPal's
 * side of each order.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import type { ProviderOrderSnapshot } from '../src/modules/billing/providers/types.js';
import { configureSandboxPaypal } from './fakes/billing-credentials.js';
import { fakePaypal } from './fakes/billing-providers.js';
import { MAX_REFUSED_CONFIRMATIONS } from '../src/modules/billing/checkout/confirm-approval.js';
import { creditsService } from '../src/modules/credits/credits.service.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';
import { RekeyError } from '../src/lib/error.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

const PASSWORD = 'pw-one-two-three';
const REGISTERED = 'https://app.example';
const PROBE_OK = { status: 'PASS', message: 'ok', fix: null, cspReports: true, at: new Date().toISOString() };

describe('PayPal one-time purchase on the checkout page', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let slug: string;
  let liveKey: string;
  let operatorAccess: string;

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
    slug = `ppo-${Math.random().toString(36).slice(2, 8)}`;
    operatorAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await configureSandboxPaypal(applicationId);
    const plan = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${operatorAccess}` },
      payload: { slug: 'pack', name: '100 Credits', amount: 4999, kind: 'CREDIT', creditsAmount: 100 },
    });
    expect(plan.statusCode, plan.body).toBe(201);
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

  async function startCheckout(
    mode: 'embedded' | 'redirect' = 'embedded',
  ): Promise<{ token: string; orderId: string; sessionId: string; endUserId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': await buyer() },
      payload: { planSlug: 'pack', successUrl: `${REGISTERED}/account?paid=1`, cancelUrl: `${REGISTERED}/account`, mode },
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as { url: string; mode: string; checkoutSessionId: string };
    expect(data.mode).toBe(mode);
    const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: data.checkoutSessionId } });
    return { token: data.url.split('/').pop()!, orderId: row.providerSessionId, sessionId: row.id, endUserId: row.endUserId };
  }

  function approve(token: string, body: Record<string, string>) {
    return app.inject({ method: 'POST', url: `/api/v1/checkout-sessions/${token}/paypal/approved`, payload: body });
  }

  function markApproved(orderId: string, patch: Partial<ProviderOrderSnapshot> = {}) {
    const current = fakePaypal.orders.get(orderId)!;
    fakePaypal.orders.set(orderId, { ...current, status: 'APPROVED', ...patch });
  }

  function orderApprovedWebhook(orderId: string, eventId = `WH-${randomUUID()}`) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/paypal/${slug}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: eventId, event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: orderId, status: 'APPROVED' } }),
    });
  }

  async function sessionRow(id: string) {
    return prisma.checkoutSession.findUniqueOrThrow({ where: { id }, include: { subscription: true } });
  }

  /** Security events are written fire-and-forget, so wait for them to land. */
  async function refusalReasons(type = 'app.checkout_confirmation_refused'): Promise<string[]> {
    const events = await waitForSecurityEvents({ applicationId, type });
    return events.map((e) => (e.metadata as { reason: string }).reason);
  }

  it('creates the order with the Rekey page as its return URL and sends the order client to the page', async () => {
    const spy = vi.spyOn(fakePaypal, 'createEmbeddedCheckout');
    const { token, orderId, sessionId } = await startCheckout();
    const input = spy.mock.calls[0]![0];
    expect(input.kind).toBe('one_time');
    expect(input.returnUrl).toMatch(new RegExp(`/${slug}/checkout/${token}$`));
    const row = await sessionRow(sessionId);
    expect(row.kind).toBe('ONE_TIME');
    expect((row.metadata as { expectedCharge: unknown }).expectedCharge).toEqual({ amount: 4999, currency: 'USD' });

    const view = await app.inject({ method: 'GET', url: `/api/v1/checkout-sessions/${token}` });
    expect(view.statusCode).toBe(200);
    const order = (view.json().data as { order: { client: unknown; plan: { kind: string; interval: unknown } } }).order;
    expect(order.client).toEqual({ provider: 'paypal', clientId: 'client_ci_only', orderId, sdk: 'v5-order', currency: 'USD' });
    expect(order.plan).toMatchObject({ kind: 'one_time', interval: null });
    expect(JSON.stringify(view.json())).not.toContain('expectedCharge');
  });

  it('moves an approved order to CONFIRMING, then the webhook captures, fulfils and completes the session', async () => {
    const { token, orderId, sessionId } = await startCheckout();
    markApproved(orderId);
    const capture = vi.spyOn(fakePaypal, 'captureOneTime');
    const res = await approve(token, { orderId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ status: 'confirming' });
    let row = await sessionRow(sessionId);
    expect(row.status).toBe('CONFIRMING');
    expect(row.subscription.status).toBe('PENDING');
    expect(capture).not.toHaveBeenCalled();

    expect((await orderApprovedWebhook(orderId)).statusCode).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    row = await sessionRow(sessionId);
    expect(row.status).toBe('COMPLETE');
    expect(row.subscription.status).toBe('ACTIVE');
    const status = await app.inject({ method: 'GET', url: `/api/v1/checkout-sessions/${token}/status` });
    expect(status.json().data).toEqual({ status: 'complete' });
    expect((await approve(token, { orderId })).json().data).toEqual({ status: 'complete' });
  });

  it('accepts an order the webhook already captured', async () => {
    const { token, orderId } = await startCheckout();
    markApproved(orderId, { status: 'COMPLETED' });
    expect((await approve(token, { orderId })).json().data).toEqual({ status: 'confirming' });
  });

  it('tells the buyer to start again after a counted refusal, and to approve again only when PayPal has not approved yet', async () => {
    const { token, orderId } = await startCheckout();
    const pending = await approve(token, { orderId });
    expect(pending.json().error.fix).toMatch(/^Approve the payment again/);
    markApproved(orderId, { amount: 1 });
    const wrong = await approve(token, { orderId });
    expect(wrong.json().error.fix).toBe('Return to the app you were buying in and start the checkout again.');
  });

  it('shows the price the order charges after the plan is re-priced', async () => {
    const { token } = await startCheckout();
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/plans/pack`,
      headers: { authorization: `Bearer ${operatorAccess}` },
      payload: { amount: 100 },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const order = (await app.inject({ method: 'GET', url: `/api/v1/checkout-sessions/${token}` })).json().data.order as {
      plan: { amount: number; currency: string };
      totalDueToday: number;
    };
    expect(order.plan).toMatchObject({ amount: 4999, currency: 'USD' });
    expect(order.totalDueToday).toBe(4999);
  });

  it.each([
    ['an order for another buyer', { customId: 'someone:else' }, 'custom_id_mismatch'],
    ['an order for a different amount', { amount: 1 }, 'amount_mismatch'],
    ['an order in a different currency', { currency: 'EUR' }, 'currency_mismatch'],
    ['an order PayPal cannot read an amount from', { amount: null, currency: null }, 'currency_mismatch'],
  ])('refuses %s', async (_label, patch, reason) => {
    const { token, orderId, sessionId } = await startCheckout();
    markApproved(orderId, patch);
    const res = await approve(token, { orderId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
    expect((await sessionRow(sessionId)).status).toBe('OPEN');
    expect(await refusalReasons()).toEqual([reason]);
  });

  it("refuses another checkout's order id, even one PayPal approved", async () => {
    const mine = await startCheckout();
    const theirs = await startCheckout();
    markApproved(theirs.orderId);
    const res = await approve(mine.token, { orderId: theirs.orderId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
    expect((await sessionRow(mine.sessionId)).status).toBe('OPEN');
    const events = await waitForSecurityEvents({ applicationId, type: 'app.checkout_confirmation_refused' });
    expect(events.map((e) => e.metadata)).toEqual([
      expect.objectContaining({ reason: 'order_id_mismatch', providerOrderId: theirs.orderId }),
    ]);
  });

  it('refuses a subscription id on a one-time checkout, even its own order id', async () => {
    const { token, orderId } = await startCheckout();
    markApproved(orderId);
    const res = await approve(token, { subscriptionId: orderId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
    expect(await refusalReasons()).toEqual(['approval_kind_mismatch']);
  });

  it('refuses a body with both ids, an unknown key or a malformed order id', async () => {
    const { token, orderId } = await startCheckout();
    markApproved(orderId);
    for (const body of [{ orderId, subscriptionId: orderId }, { paymentId: orderId }, {}, { orderId: '../../v2/x' }]) {
      expect((await approve(token, body)).statusCode).toBe(400);
    }
    expect((await approve(token, { orderId })).statusCode).toBe(200);
  });

  it('refuses an order PayPal does not know', async () => {
    const { token, orderId } = await startCheckout();
    fakePaypal.orders.delete(orderId);
    expect((await approve(token, { orderId })).json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
    expect(await refusalReasons()).toEqual(['unknown_at_paypal']);
  });

  it('does not count a not-yet-approved order, and stops after repeated counted refusals', async () => {
    const { token, orderId } = await startCheckout();
    for (let i = 0; i < 2; i++) {
      expect((await approve(token, { orderId })).json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
    }
    for (let i = 0; i < MAX_REFUSED_CONFIRMATIONS; i++) {
      expect((await approve(token, { orderId: 'FORGED0000' })).json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
    }
    markApproved(orderId);
    const res = await approve(token, { orderId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_LIMIT');
  });

  it('refuses a confirmation after the credentials moved from sandbox to live', async () => {
    const { token, orderId } = await startCheckout();
    markApproved(orderId);
    await prisma.billingCredentials.update({
      where: { applicationId_provider: { applicationId, provider: 'paypal' } },
      data: { mode: 'live' },
    });
    const res = await approve(token, { orderId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHECKOUT_MODE_MISMATCH');
  });

  it('does not capture an order whose session was started in the other mode', async () => {
    const { orderId, sessionId } = await startCheckout();
    markApproved(orderId);
    await prisma.billingCredentials.update({
      where: { applicationId_provider: { applicationId, provider: 'paypal' } },
      data: { mode: 'live' },
    });
    const capture = vi.spyOn(fakePaypal, 'captureOneTime');
    expect((await orderApprovedWebhook(orderId)).statusCode).toBe(200);
    expect(capture).not.toHaveBeenCalled();
    const row = await sessionRow(sessionId);
    expect(row.status).toBe('EXPIRED');
    expect(row.subscription.status).toBe('PENDING');
  });

  describe('the capture webhook checks the order before it moves money', () => {
    async function webhookReceipt(eventId: string) {
      return prisma.webhookEvent.findFirstOrThrow({ where: { applicationId, providerEventId: eventId } });
    }

    async function expectNotCaptured(orderId: string, sessionId: string, reason: string) {
      const capture = vi.spyOn(fakePaypal, 'captureOneTime');
      const eventId = `WH-${randomUUID()}`;
      expect((await orderApprovedWebhook(orderId, eventId)).statusCode).toBe(200);
      expect(capture).not.toHaveBeenCalled();
      const row = await sessionRow(sessionId);
      expect(row.status).not.toBe('COMPLETE');
      expect(row.subscription.status).toBe('PENDING');
      const receipt = await webhookReceipt(eventId);
      expect(receipt.processedAt).not.toBeNull();
      expect(receipt.processingError).toContain(`CHECKOUT_CAPTURE_REFUSED: order ${orderId} not captured (${reason})`);
      expect(await refusalReasons('app.checkout_capture_refused')).toEqual([reason]);
    }

    it.each([
      ['an amount PayPal now reports differently', { amount: 1 }, 'amount_mismatch'],
      ['another currency', { currency: 'EUR' }, 'currency_mismatch'],
      ['another buyer', { customId: 'someone:else' }, 'custom_id_mismatch'],
    ])('does not capture an embedded order with %s, even after a refused confirmation', async (_label, patch, reason) => {
      const { token, orderId, sessionId } = await startCheckout();
      markApproved(orderId, patch);
      expect((await approve(token, { orderId })).statusCode).toBe(409);
      await expectNotCaptured(orderId, sessionId, reason);
    });

    it('does not capture an order PayPal no longer knows', async () => {
      const { orderId, sessionId } = await startCheckout();
      fakePaypal.orders.delete(orderId);
      await expectNotCaptured(orderId, sessionId, 'unknown_at_paypal');
    });

    it("records a redirect order's charge and refuses to capture a different one", async () => {
      const { orderId, sessionId } = await startCheckout('redirect');
      expect((await sessionRow(sessionId)).metadata).toMatchObject({ expectedCharge: { amount: 4999, currency: 'USD' } });
      markApproved(orderId, { amount: 4998 });
      await expectNotCaptured(orderId, sessionId, 'amount_mismatch');
    });

    it('checks a redirect order recorded before charges were stored against the plan price', async () => {
      const first = await startCheckout('redirect');
      await prisma.checkoutSession.update({ where: { id: first.sessionId }, data: { metadata: {} } });
      markApproved(first.orderId, { amount: 1 });
      await expectNotCaptured(first.orderId, first.sessionId, 'amount_mismatch');

      const second = await startCheckout('redirect');
      await prisma.checkoutSession.update({ where: { id: second.sessionId }, data: { metadata: {} } });
      expect((await orderApprovedWebhook(second.orderId)).statusCode).toBe(200);
      expect((await sessionRow(second.sessionId)).subscription.status).toBe('ACTIVE');
    });
  });

  it('fulfils once and announces once when eight deliveries of the approval arrive together', async () => {
    const { endpoint } = await webhookService.createEndpoint({
      applicationId,
      // Unreachable on purpose: delivery rows are the assertion, not HTTP success.
      url: 'https://example.invalid/onetime-hook',
      events: ['*'],
    });
    const { orderId, sessionId, endUserId } = await startCheckout();
    markApproved(orderId);
    const capture = vi.spyOn(fakePaypal, 'captureOneTime');
    const results = await Promise.all(Array.from({ length: 8 }, () => orderApprovedWebhook(orderId)));
    expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    // Each delivery may ask PayPal to capture; the provider sends one
    // PayPal-Request-Id per order (paypal-embedded-provider.test.ts), so
    // PayPal charges once. Fulfilment must happen exactly once.
    expect(capture.mock.calls.every(([id]) => id === orderId)).toBe(true);
    expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(100);
    expect(await prisma.webhookDelivery.count({ where: { endpointId: endpoint.id, eventType: 'subscription.activated' } })).toBe(1);
    const row = await sessionRow(sessionId);
    expect(row.status).toBe('COMPLETE');
    expect(row.subscription.status).toBe('ACTIVE');
  });

  describe('a delivery that fails part-way is retried to completion', () => {
    function deliveryWith(eventId: string, orderId: string) {
      return orderApprovedWebhook(orderId, eventId);
    }

    it('fulfils on the retry after the capture succeeded and provisioning threw', async () => {
      const { orderId, sessionId, endUserId } = await startCheckout();
      markApproved(orderId);
      const eventId = `WH-${randomUUID()}`;
      vi.spyOn(entitlementsService, 'provision').mockRejectedValueOnce(new Error('provisioning outage'));
      const capture = vi.spyOn(fakePaypal, 'captureOneTime');
      expect((await deliveryWith(eventId, orderId)).statusCode).toBe(500);
      expect(capture).toHaveBeenCalledTimes(1);
      const receipt = await prisma.webhookEvent.findFirstOrThrow({ where: { applicationId, providerEventId: eventId } });
      expect(receipt.processedAt).toBeNull();

      expect((await deliveryWith(eventId, orderId)).statusCode).toBe(200);
      expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(100);
      const row = await sessionRow(sessionId);
      expect(row.status).toBe('COMPLETE');
      expect(row.subscription.status).toBe('ACTIVE');
    });

    it('captures and fulfils on the retry after reading the order failed', async () => {
      const { orderId, sessionId, endUserId } = await startCheckout();
      markApproved(orderId);
      const eventId = `WH-${randomUUID()}`;
      vi.spyOn(fakePaypal, 'getOrder').mockRejectedValueOnce(
        new RekeyError({ statusCode: 502, code: 'BILLING_PROVIDER_REFUSED', message: 'PayPal refused the order read (HTTP 503).', fix: 'Retry.' }),
      );
      const capture = vi.spyOn(fakePaypal, 'captureOneTime');
      expect((await deliveryWith(eventId, orderId)).statusCode).toBeGreaterThanOrEqual(500);
      expect(capture).not.toHaveBeenCalled();

      expect((await deliveryWith(eventId, orderId)).statusCode).toBe(200);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(100);
      expect((await sessionRow(sessionId)).status).toBe('COMPLETE');
    });
  });

  it('captures once and completes once when eight confirmations race the webhook', async () => {
    const { token, orderId, sessionId } = await startCheckout();
    markApproved(orderId);
    const capture = vi.spyOn(fakePaypal, 'captureOneTime');
    const verified = vi.spyOn(fakePaypal, 'getOrder');
    const [webhook, ...approvals] = await Promise.all([
      orderApprovedWebhook(orderId),
      ...Array.from({ length: 8 }, () => approve(token, { orderId })),
    ]);
    expect(webhook!.statusCode).toBe(200);
    expect(approvals.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    for (const r of approvals) expect(['confirming', 'complete']).toContain((r.json().data as { status: string }).status);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(verified.mock.calls.every(([id]) => id === orderId)).toBe(true);
    const row = await sessionRow(sessionId);
    expect(row.status).toBe('COMPLETE');
    expect(row.subscription.status).toBe('ACTIVE');
  });

  it('passes the provider check for a one-time PayPal plan', async () => {
    await prisma.webhookEvent.create({
      data: { applicationId, provider: 'paypal', providerEventId: `WH-${randomUUID()}`, eventType: 'PAYMENT.CAPTURE.COMPLETED', payload: {}, mode: 'test' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/checkout/readiness`,
      headers: { authorization: `Bearer ${operatorAccess}` },
    });
    const data = res.json().data as { test: Array<{ id: string; status: string; message: string }> };
    expect(data.test.find((c) => c.id === 'provider')).toMatchObject({ status: 'PASS' });
    expect(data.test.find((c) => c.id === 'plans')).toMatchObject({ status: 'PASS' });
  });
});
