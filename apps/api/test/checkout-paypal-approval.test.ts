/**
 * PayPal on the Rekey-hosted checkout page: the page's "approved" is checked
 * against PayPal and moves the session to CONFIRMING only; activation comes
 * from PayPal's webhook alone. Runs with the fake PayPal provider, whose
 * `subscriptions` map is PayPal's side of each subscription.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { configureSandboxPaypal } from './fakes/billing-credentials.js';
import { fakePaypal } from './fakes/billing-providers.js';
import { MAX_REFUSED_CONFIRMATIONS } from '../src/modules/billing/checkout/confirm-approval.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

const PASSWORD = 'pw-one-two-three';
const REGISTERED = 'https://app.example';
const PORTAL = new URL(process.env.PUBLIC_PORTAL_URL!).origin;
const PROBE_OK = { status: 'PASS', message: 'ok', fix: null, cspReports: true, at: new Date().toISOString() };

describe('PayPal approval on the checkout page', () => {
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
    // A background re-probe must not reach the network.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"cspReports":true}', { status: 200 }));
    slug = `ppa-${Math.random().toString(36).slice(2, 8)}`;
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
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${operatorAccess}` },
      payload: { slug: 'standard', name: 'Cloud Standard', amount: 9900 },
    });
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

  async function startCheckout(userAccess?: string): Promise<{ token: string; subscriptionId: string; sessionId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess ?? (await buyer()) },
      payload: { planSlug: 'standard', successUrl: `${REGISTERED}/account?paid=1`, cancelUrl: `${REGISTERED}/account` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as { url: string; mode: string; checkoutSessionId: string };
    expect(data.mode).toBe('embedded');
    const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: data.checkoutSessionId } });
    return { token: data.url.split('/').pop()!, subscriptionId: row.providerSessionId, sessionId: row.id };
  }

  function approve(token: string, subscriptionId: string, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/checkout-sessions/${token}/paypal/approved`,
      headers,
      payload: { subscriptionId },
    });
  }

  function markApproved(subscriptionId: string, patch: Partial<{ status: string; planId: string; customId: string }> = {}) {
    const current = fakePaypal.subscriptions.get(subscriptionId)!;
    fakePaypal.subscriptions.set(subscriptionId, { ...current, status: 'APPROVED', ...patch });
  }

  function activate(subscriptionId: string, eventId = `WH-${randomUUID()}`) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/paypal/${slug}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        id: eventId,
        event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
        resource: { id: subscriptionId, status: 'ACTIVE', custom_id: `${applicationId}:x` },
      }),
    });
  }

  async function sessionRow(id: string) {
    return prisma.checkoutSession.findUniqueOrThrow({ where: { id }, include: { subscription: true } });
  }

  it('moves an approved checkout to CONFIRMING and activates nothing', async () => {
    const { token, subscriptionId, sessionId } = await startCheckout();
    markApproved(subscriptionId);
    const res = await approve(token, subscriptionId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ status: 'confirming' });
    const row = await sessionRow(sessionId);
    expect(row.status).toBe('CONFIRMING');
    expect(row.subscription.status).toBe('PENDING');
    const status = await app.inject({ method: 'GET', url: `/api/v1/checkout-sessions/${token}/status` });
    expect(status.json().data).toEqual({ status: 'confirming' });
  });

  it('activates only from the webhook, and a replayed webhook changes nothing', async () => {
    const { token, subscriptionId, sessionId } = await startCheckout();
    markApproved(subscriptionId);
    await approve(token, subscriptionId);
    const eventId = `WH-${randomUUID()}`;
    expect((await activate(subscriptionId, eventId)).statusCode).toBe(200);
    let row = await sessionRow(sessionId);
    expect(row.status).toBe('COMPLETE');
    expect(row.subscription.status).toBe('ACTIVE');
    const activatedAt = row.subscription.updatedAt.getTime();

    expect((await activate(subscriptionId, eventId)).statusCode).toBe(200);
    row = await sessionRow(sessionId);
    expect(row.subscription.status).toBe('ACTIVE');
    expect(row.subscription.updatedAt.getTime()).toBe(activatedAt);
    expect(await prisma.webhookEvent.count({ where: { applicationId, providerEventId: eventId } })).toBe(1);
    expect((await app.inject({ method: 'GET', url: `/api/v1/checkout-sessions/${token}/status` })).json().data).toEqual({
      status: 'complete',
    });
    expect((await approve(token, subscriptionId)).json().data).toEqual({ status: 'complete' });
  });

  it("refuses another checkout's subscription id, even one PayPal approved", async () => {
    const mine = await startCheckout();
    const theirs = await startCheckout();
    markApproved(theirs.subscriptionId);
    const res = await approve(mine.token, theirs.subscriptionId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
    expect((await sessionRow(mine.sessionId)).status).toBe('OPEN');
    const events = await waitForSecurityEvents({ applicationId, type: 'app.checkout_confirmation_refused' });
    expect(events.map((e) => (e.metadata as { reason: string }).reason)).toEqual(['subscription_id_mismatch']);
  });

  it.each([
    ['a subscription PayPal has not approved', { status: 'APPROVAL_PENDING' }],
    ['a subscription for another buyer', { customId: 'someone:else' }],
    ['a subscription on another plan', { planId: 'P-OTHER' }],
  ])('refuses %s', async (_label, patch) => {
    const { token, subscriptionId, sessionId } = await startCheckout();
    markApproved(subscriptionId, patch);
    const res = await approve(token, subscriptionId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
    expect((await sessionRow(sessionId)).status).toBe('OPEN');
  });

  it('refuses a subscription PayPal does not know', async () => {
    const { token, subscriptionId } = await startCheckout();
    fakePaypal.subscriptions.delete(subscriptionId);
    expect((await approve(token, subscriptionId)).json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
  });

  it('stops accepting confirmations after repeated refusals', async () => {
    const { token, subscriptionId } = await startCheckout();
    for (let i = 0; i < MAX_REFUSED_CONFIRMATIONS; i++) {
      expect((await approve(token, 'I-FORGED0000')).json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
    }
    markApproved(subscriptionId);
    const res = await approve(token, subscriptionId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_LIMIT');
  });

  it('does not count not-yet-approved refusals, so refreshes after a cancelled window cannot lock out the real approval', async () => {
    const { token, subscriptionId } = await startCheckout();
    for (let i = 0; i < MAX_REFUSED_CONFIRMATIONS + 3; i++) {
      expect((await approve(token, subscriptionId)).json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
    }
    markApproved(subscriptionId);
    expect((await approve(token, subscriptionId)).json().data).toEqual({ status: 'confirming' });
  });

  describe('a second checkout while the first is paid at PayPal', () => {
    function checkoutAs(userAccess: string) {
      return app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
        payload: { planSlug: 'standard', successUrl: `${REGISTERED}/account?paid=1`, cancelUrl: `${REGISTERED}/account` },
      });
    }

    it('is refused while the first session is confirming', async () => {
      const user = await buyer();
      const first = await startCheckout(user);
      markApproved(first.subscriptionId);
      await approve(first.token, first.subscriptionId);
      // The CONFIRMING status alone must refuse, without asking PayPal again.
      fakePaypal.subscriptions.delete(first.subscriptionId);
      const spy = vi.spyOn(fakePaypal, 'createEmbeddedCheckout');
      const second = await checkoutAs(user);
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('CHECKOUT_PAYMENT_IN_PROGRESS');
      expect(spy).not.toHaveBeenCalled();
    });

    it('is refused when PayPal reports the open session approved, and that session becomes confirming', async () => {
      const user = await buyer();
      const first = await startCheckout(user);
      markApproved(first.subscriptionId);
      const second = await checkoutAs(user);
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('CHECKOUT_PAYMENT_IN_PROGRESS');
      expect((await sessionRow(first.sessionId)).status).toBe('CONFIRMING');
    });

    it('is allowed while the first is still waiting for approval, and a day after it expired', async () => {
      const user = await buyer();
      const first = await startCheckout(user);
      expect((await checkoutAs(user)).statusCode).toBe(200);
      markApproved(first.subscriptionId);
      const subscriptionId = (await sessionRow(first.sessionId)).subscriptionId;
      await prisma.checkoutSession.updateMany({
        where: { subscriptionId },
        data: { status: 'EXPIRED', expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
      expect((await checkoutAs(user)).statusCode).toBe(200);
    });

    it('is refused when the first was approved at PayPal just after its link expired', async () => {
      const user = await buyer();
      const first = await startCheckout(user);
      await prisma.checkoutSession.update({
        where: { id: first.sessionId },
        data: { status: 'EXPIRED', expiresAt: new Date(Date.now() - 60_000) },
      });
      markApproved(first.subscriptionId);
      const second = await checkoutAs(user);
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('CHECKOUT_PAYMENT_IN_PROGRESS');
      expect((await sessionRow(first.sessionId)).status).toBe('CONFIRMING');
    });
  });

  it('makes one transition out of eight concurrent confirmations', async () => {
    const { token, subscriptionId, sessionId } = await startCheckout();
    markApproved(subscriptionId);
    // Spy on the fake, never on a Prisma delegate: restoring a spy on the
    // delegate proxy writes undefined back and breaks later tests.
    const verified = vi.spyOn(fakePaypal, 'getSubscription');
    const results = await Promise.all(Array.from({ length: 8 }, () => approve(token, subscriptionId)));
    expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    expect(new Set(results.map((r) => (r.json().data as { status: string }).status))).toEqual(new Set(['confirming']));
    expect(verified.mock.calls.length).toBeLessThanOrEqual(8);
    expect(verified.mock.calls.every(([id]) => id === subscriptionId)).toBe(true);
    const row = await sessionRow(sessionId);
    expect(row.status).toBe('CONFIRMING');
    expect(row.subscription.status).toBe('PENDING');
  });

  it('refuses a confirmation after the credentials moved from sandbox to live', async () => {
    const { token, subscriptionId } = await startCheckout();
    markApproved(subscriptionId);
    await prisma.billingCredentials.update({
      where: { applicationId_provider: { applicationId, provider: 'paypal' } },
      data: { mode: 'live' },
    });
    const res = await approve(token, subscriptionId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHECKOUT_MODE_MISMATCH');
  });

  it('runs in live mode with a live token and the live setting', async () => {
    await prisma.billingCredentials.update({
      where: { applicationId_provider: { applicationId, provider: 'paypal' } },
      data: { mode: 'live' },
    });
    await prisma.webhookEvent.create({
      data: { applicationId, provider: 'paypal', providerEventId: `WH-${randomUUID()}`, eventType: 'PAYMENT.SALE.COMPLETED', payload: {}, mode: 'live', receivedAt: new Date() },
    });
    const { token, subscriptionId, sessionId } = await startCheckout();
    expect(token.startsWith('chk_live_')).toBe(true);
    expect((await sessionRow(sessionId)).paymentMode).toBe('LIVE');
    markApproved(subscriptionId);
    expect((await approve(token, subscriptionId)).json().data).toEqual({ status: 'confirming' });
    expect((await activate(subscriptionId)).statusCode).toBe(200);
    expect((await sessionRow(sessionId)).status).toBe('COMPLETE');
  });

  it('refuses a cross-site POST and a malformed subscription id', async () => {
    const { token, subscriptionId } = await startCheckout();
    markApproved(subscriptionId);
    expect((await approve(token, subscriptionId, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await approve(token, subscriptionId, { origin: PORTAL })).statusCode).toBe(200);
    expect((await approve(token, '../../v1/oauth2/token')).statusCode).toBe(400);
    expect((await approve(token, 'I-' + 'A'.repeat(80))).statusCode).toBe(400);
  });
});
