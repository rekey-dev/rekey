/**
 * Stripe on the Rekey-hosted checkout page: an elements Checkout Session, the
 * page's "paid" checked against Stripe and moving the session to CONFIRMING
 * only, the hosted fallback that replaces the elements session, and the
 * readiness check for the publishable key. Runs with the fake Stripe
 * provider, whose `sessions` map is Stripe's side of each Checkout Session.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import Stripe from 'stripe';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { STRIPE_API_VERSION } from '../src/modules/billing/providers/stripe-api-version.js';
import { MAX_REFUSED_CONFIRMATIONS } from '../src/modules/billing/checkout/confirm-approval.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';
import { configureSandboxPaypal } from './fakes/billing-credentials.js';
import { fakeStripe } from './fakes/billing-providers.js';

const PASSWORD = 'pw-one-two-three';
const REGISTERED = 'https://app.example';
const PORTAL = new URL(process.env.PUBLIC_PORTAL_URL!).origin;
const PROBE_OK = { status: 'PASS', message: 'ok', fix: null, cspReports: true, at: new Date().toISOString() };
const WEBHOOK_SECRET = 'whsec_stripe_embedded_ci';
const SECRET_KEY = 'sk_test_ci_only_embedded';
const signer = new Stripe('sk_for_signing_only', { apiVersion: STRIPE_API_VERSION });

describe('Stripe on the checkout page', () => {
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
    fakeStripe.sessions.clear();
    fakeStripe.fallbacks.length = 0;
    slug = `sti-${Math.random().toString(36).slice(2, 8)}`;
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
    await billingCredentialsService.upsertCredentials(
      applicationId,
      'stripe',
      { apiKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET, publishableKey: 'pk_test_ci_only' },
      { mode: 'test' },
    );
    const plan = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${operatorAccess}` },
      payload: { slug: 'standard', name: 'Standard', amount: 9900 },
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

  function checkoutRequest(userAccess: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
      payload: { planSlug: 'standard', successUrl: `${REGISTERED}/account?paid=1`, cancelUrl: `${REGISTERED}/account`, ...extra },
    });
  }

  async function startCheckout(
    userAccess?: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ token: string; providerSessionId: string; rowId: string; body: string }> {
    const res = await checkoutRequest(userAccess ?? (await buyer()), extra);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as { url: string; mode: string; checkoutSessionId: string; warnings?: unknown };
    expect(data.mode, JSON.stringify(data.warnings)).toBe('embedded');
    const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: data.checkoutSessionId } });
    return { token: data.url.split('/').pop()!, providerSessionId: row.providerSessionId, rowId: row.id, body: res.body };
  }

  function confirm(token: string, sessionId: string, headers: Record<string, string> = {}, via?: 'page' | 'return') {
    return app.inject({
      method: 'POST',
      url: `/api/v1/checkout-sessions/${token}/stripe/confirmed`,
      headers,
      payload: { sessionId, ...(via && { via }) },
    });
  }

  async function refusedCount(rowId: string): Promise<number | undefined> {
    return ((await row(rowId)).metadata as { refusedConfirmations?: number }).refusedConfirmations;
  }

  async function stampExpectedCharge(rowId: string, amount: number, currency: string): Promise<void> {
    const current = await row(rowId);
    await prisma.checkoutSession.update({
      where: { id: rowId },
      data: { metadata: { ...(current.metadata as Prisma.JsonObject), expectedCharge: { amount, currency } } },
    });
  }

  function markPaid(id: string, patch: Partial<{ status: string; paymentStatus: string; clientReferenceId: string | null }> = {}) {
    const current = fakeStripe.sessions.get(id)!;
    fakeStripe.sessions.set(id, { ...current, status: 'complete', paymentStatus: 'paid', ...patch });
  }

  async function row(id: string) {
    return prisma.checkoutSession.findUniqueOrThrow({ where: { id }, include: { subscription: true } });
  }

  function completedEvent(sessionId: string, type = 'checkout.session.completed', subscription = `sub_${randomUUID().slice(0, 8)}`) {
    const payload = JSON.stringify({
      id: `evt_${randomUUID()}`,
      object: 'event',
      type,
      livemode: false,
      data: { object: { id: sessionId, subscription, payment_status: 'paid', metadata: { applicationId } } },
    });
    return app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${slug}`,
      headers: { 'stripe-signature': signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }), 'content-type': 'application/json' },
      payload,
    });
  }

  describe('the page view', () => {
    it('sends the publishable key and the session client secret, never the secret key', async () => {
      const { token, providerSessionId, body } = await startCheckout();
      expect(fakeStripe.lastEmbedded!.kind).toBe('recurring');
      expect(fakeStripe.lastEmbedded!.returnUrl).toBe(`${PORTAL}/${slug}/checkout/${token}`);
      const view = await app.inject({ method: 'GET', url: `/api/v1/checkout-sessions/${token}` });
      expect(view.statusCode).toBe(200);
      expect(view.json().data.order.client).toEqual({
        provider: 'stripe',
        publishableKey: 'pk_test_ci_only',
        clientSecret: `${providerSessionId}_secret_ci`,
        sdk: 'elements',
      });
      for (const text of [view.body, body]) {
        expect(text).not.toContain(SECRET_KEY);
        expect(text).not.toContain(WEBHOOK_SECRET);
      }
    });
  });

  describe('confirmation', () => {
    it('moves a paid session to confirming and activates nothing', async () => {
      const { token, providerSessionId, rowId } = await startCheckout();
      markPaid(providerSessionId);
      const res = await confirm(token, providerSessionId, { origin: PORTAL });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toEqual({ status: 'confirming' });
      const after = await row(rowId);
      expect(after.status).toBe('CONFIRMING');
      expect(after.subscription.status).toBe('PENDING');
      expect((await confirm(token, providerSessionId)).json().data).toEqual({ status: 'confirming' });
    });

    it('moves a complete but unpaid session (a bank debit still settling) to confirming', async () => {
      const { token, providerSessionId, rowId } = await startCheckout();
      markPaid(providerSessionId, { paymentStatus: 'unpaid' });
      expect((await confirm(token, providerSessionId)).json().data).toEqual({ status: 'confirming' });
      const after = await row(rowId);
      expect(after.status).toBe('CONFIRMING');
      expect(after.subscription.status).toBe('PENDING');
    });

    it('accepts an order whose Stripe total matches what the session recorded, and refuses one that does not', async () => {
      const ok = await startCheckout();
      markPaid(ok.providerSessionId);
      await stampExpectedCharge(ok.rowId, 9900, 'USD');
      expect((await confirm(ok.token, ok.providerSessionId)).json().data).toEqual({ status: 'confirming' });

      const off = await startCheckout();
      markPaid(off.providerSessionId);
      await stampExpectedCharge(off.rowId, 4900, 'USD');
      const res = await confirm(off.token, off.providerSessionId);
      expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
      expect(await refusedCount(off.rowId)).toBe(1);
      expect((await row(off.rowId)).status).toBe('OPEN');
    });

    it('does not confirm a session the row stopped naming while Stripe was being asked', async () => {
      const { token, providerSessionId, rowId } = await startCheckout();
      markPaid(providerSessionId);
      const read = fakeStripe.getCheckoutSession.bind(fakeStripe);
      vi.spyOn(fakeStripe, 'getCheckoutSession').mockImplementation(async (id) => {
        await prisma.checkoutSession.update({ where: { id: rowId }, data: { providerSessionId: 'cs_test_replaced' } });
        return read(id);
      });
      const res = await confirm(token, providerSessionId);
      expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
      expect((await row(rowId)).status).toBe('OPEN');
    });

    it('does not count a refusal from the page-load return path', async () => {
      const { token, rowId } = await startCheckout();
      const res = await confirm(token, `cs_test_${'r'.repeat(20)}`, {}, 'return');
      expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
      expect(await refusedCount(rowId)).toBeUndefined();
    });

    it('accepts a trial session that needed no payment', async () => {
      const { token, providerSessionId } = await startCheckout();
      markPaid(providerSessionId, { paymentStatus: 'no_payment_required' });
      expect((await confirm(token, providerSessionId)).json().data).toEqual({ status: 'confirming' });
    });

    it('completes only from the webhook', async () => {
      const { token, providerSessionId, rowId } = await startCheckout();
      markPaid(providerSessionId);
      await confirm(token, providerSessionId);
      const hook = await completedEvent(providerSessionId);
      expect(hook.statusCode, hook.body).toBe(200);
      const after = await row(rowId);
      expect(after.status).toBe('COMPLETE');
      expect(after.subscription.status).toBe('ACTIVE');
    });

    const counted: Array<[string, (id: string) => void, (id: string) => string]> = [
      ['another session id', (id) => markPaid(id), () => `cs_test_${'x'.repeat(20)}`],
      ['a paid session Stripe knows that is not this checkout’s', () => undefined, (id) => paidTwin(id)],
      ['a session Stripe does not know', (id) => fakeStripe.sessions.delete(id), (id) => id],
      ['another Application', (id) => markPaid(id), (id) => tamper(id, { applicationId: 'app_other' })],
      ['another buyer', (id) => markPaid(id), (id) => tamper(id, { endUserId: 'eu_other' })],
      ['another plan', (id) => markPaid(id), (id) => tamper(id, { planId: 'plan_other' })],
      ['a foreign client_reference_id', (id) => markPaid(id, { clientReferenceId: 'app:eu' }), (id) => id],
    ];

    /** A paid session identical to this checkout's in every stamp, under another id: only the id check stops it. */
    function paidTwin(id: string): string {
      const twin = `cs_test_twin${randomUUID().replace(/-/g, '')}`;
      fakeStripe.sessions.set(twin, { ...fakeStripe.sessions.get(id)!, id: twin, status: 'complete', paymentStatus: 'paid' });
      return twin;
    }

    function tamper(id: string, metadata: Partial<{ applicationId: string; endUserId: string; planId: string }>): string {
      const current = fakeStripe.sessions.get(id)!;
      fakeStripe.sessions.set(id, { ...current, metadata: { ...current.metadata, ...metadata } });
      return id;
    }

    for (const [what, arrange, claim] of counted) {
      it(`refuses ${what}, counts it and records a security event`, async () => {
        const { token, providerSessionId, rowId } = await startCheckout();
        arrange(providerSessionId);
        const res = await confirm(token, claim(providerSessionId));
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
        const after = await row(rowId);
        expect(after.status).toBe('OPEN');
        expect((after.metadata as { refusedConfirmations?: number }).refusedConfirmations).toBe(1);
        expect(await waitForSecurityEvents({ applicationId, type: 'app.checkout_confirmation_refused' })).toHaveLength(1);
      });
    }

    for (const [status, paymentStatus] of [
      ['open', 'unpaid'],
      ['expired', 'unpaid'],
      ['open', 'no_payment_required'],
      ['expired', 'no_payment_required'],
    ] as const) {
      it(`refuses a ${status} / ${paymentStatus} session without counting it`, async () => {
        const { token, providerSessionId, rowId } = await startCheckout();
        markPaid(providerSessionId, { status, paymentStatus });
        const res = await confirm(token, providerSessionId);
        expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_REFUSED');
        const after = await row(rowId);
        expect(after.status).toBe('OPEN');
        expect((after.metadata as { refusedConfirmations?: number }).refusedConfirmations).toBeUndefined();
      });
    }

    it('stops after too many refusals, even for the genuine session', async () => {
      const { token, providerSessionId } = await startCheckout();
      for (let i = 0; i < MAX_REFUSED_CONFIRMATIONS; i += 1) await confirm(token, `cs_test_wrong${i}`);
      markPaid(providerSessionId);
      const res = await confirm(token, providerSessionId);
      expect(res.json().error.code).toBe('CHECKOUT_CONFIRMATION_LIMIT');
    });

    it('refuses a cross-site browser and a malformed id', async () => {
      const { token, providerSessionId } = await startCheckout();
      markPaid(providerSessionId);
      expect((await confirm(token, providerSessionId, { origin: 'https://evil.example' })).statusCode).toBe(403);
      expect((await confirm(token, 'pi_123')).statusCode).toBe(400);
    });

    it('refuses a session started in test mode once the credentials are live', async () => {
      const { token, providerSessionId, rowId } = await startCheckout();
      markPaid(providerSessionId);
      await prisma.billingCredentials.update({
        where: { applicationId_provider: { applicationId, provider: 'stripe' } },
        data: { mode: 'live' },
      });
      const res = await confirm(token, providerSessionId);
      expect(res.json().error.code).toBe('CHECKOUT_MODE_MISMATCH');
      expect((await row(rowId)).status).toBe('EXPIRED');
    });
  });

  describe('a second checkout while the first is settling', () => {
    it('refuses a new checkout for the plan while the earlier Stripe session is complete and unpaid', async () => {
      const user = await buyer();
      const first = await startCheckout(user);
      markPaid(first.providerSessionId, { paymentStatus: 'unpaid' });
      const second = await checkoutRequest(user);
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('CHECKOUT_PAYMENT_IN_PROGRESS');
      expect((await row(first.rowId)).status).toBe('CONFIRMING');
    });

    it('lets a new checkout through while the earlier Stripe session is still open', async () => {
      const user = await buyer();
      await startCheckout(user);
      expect((await checkoutRequest(user)).statusCode).toBe(200);
    });

    it('refuses when the Stripe provider cannot be loaded although its credentials exist', async () => {
      const user = await buyer();
      await startCheckout(user);
      const providers = await import('../src/modules/billing/providers/index.js');
      const load = vi.mocked(providers.getProviderForApplication);
      const real = load.getMockImplementation()!;
      load.mockImplementation(async (application, provider) => {
        if (provider === 'stripe' && load.mock.calls.length === 1) throw new Error('cannot decrypt');
        return real(application, provider);
      });
      load.mockClear();
      try {
        const res = await checkoutRequest(user);
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe('CHECKOUT_PAYMENT_STATUS_UNAVAILABLE');
      } finally {
        load.mockImplementation(real);
      }
    });

    it('does not ask Stripe once its credentials were removed', async () => {
      const user = await buyer();
      const first = await startCheckout(user);
      markPaid(first.providerSessionId, { paymentStatus: 'unpaid' });
      await prisma.billingCredentials.delete({ where: { applicationId_provider: { applicationId, provider: 'stripe' } } });
      await configureSandboxPaypal(applicationId);
      const read = vi.spyOn(fakeStripe, 'getCheckoutSession');
      const res = await checkoutRequest(user, { mode: 'redirect' });
      expect(res.statusCode, res.body).toBe(200);
      expect(read).not.toHaveBeenCalled();
    });

    it('refuses rather than guesses when Stripe cannot be asked', async () => {
      const user = await buyer();
      await startCheckout(user);
      vi.spyOn(fakeStripe, 'getCheckoutSession').mockRejectedValue(new Error('stripe down'));
      const res = await checkoutRequest(user);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('CHECKOUT_PAYMENT_STATUS_UNAVAILABLE');
    });
  });

  describe('a bank debit that fails after the checkout completed', () => {
    it('closes the confirming session, releases its trial slot, and lets the buyer start again', async () => {
      await prisma.plan.updateMany({ where: { applicationId }, data: { trialDays: 14 } });
      const user = await buyer();
      const first = await startCheckout(user);
      markPaid(first.providerSessionId, { paymentStatus: 'unpaid' });
      await confirm(first.token, first.providerSessionId);
      expect((await checkoutRequest(user)).json().error.code).toBe('CHECKOUT_PAYMENT_IN_PROGRESS');

      const hook = await completedEvent(first.providerSessionId, 'checkout.session.async_payment_failed');
      expect(hook.statusCode, hook.body).toBe(200);
      const closed = await row(first.rowId);
      expect(closed.status).toBe('EXPIRED');
      expect((closed.metadata as { paymentFailedAt?: string }).paymentFailedAt).toEqual(expect.any(String));
      expect(closed.subscription.status).toBe('PENDING');
      const slots = await prisma.trialRedemption.findMany({ where: { applicationId, checkoutSessionId: first.providerSessionId } });
      expect(slots.map((s) => s.status)).toEqual(['RELEASED']);

      // Stripe still reports the failed session `complete`; the guard must not count it.
      expect(fakeStripe.sessions.get(first.providerSessionId)!.status).toBe('complete');
      const again = await checkoutRequest(user);
      expect(again.statusCode, again.body).toBe(200);
      expect((await row(first.rowId)).status).toBe('EXPIRED');
    });

    it('cancels the Stripe subscription the failed session created, at once', async () => {
      const first = await startCheckout();
      markPaid(first.providerSessionId, { paymentStatus: 'unpaid' });
      await confirm(first.token, first.providerSessionId);
      const cancel = vi.spyOn(fakeStripe, 'cancelSubscription');
      const hook = await completedEvent(first.providerSessionId, 'checkout.session.async_payment_failed', 'sub_failed_debit');
      expect(hook.statusCode, hook.body).toBe(200);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel.mock.calls[0]![0]).toMatchObject({ atPeriodEnd: false, subscription: { providerSubId: 'sub_failed_debit' } });
    });

    it('never cancels a subscription the local row activated under', async () => {
      const first = await startCheckout();
      markPaid(first.providerSessionId);
      await confirm(first.token, first.providerSessionId);
      expect((await completedEvent(first.providerSessionId, 'checkout.session.completed', 'sub_paying')).statusCode).toBe(200);
      const before = await row(first.rowId);
      expect(before.subscription).toMatchObject({ status: 'ACTIVE', providerSubId: 'sub_paying' });

      const cancel = vi.spyOn(fakeStripe, 'cancelSubscription');
      const hook = await completedEvent(first.providerSessionId, 'checkout.session.async_payment_failed', 'sub_paying');
      expect(hook.statusCode, hook.body).toBe(200);
      expect(cancel).not.toHaveBeenCalled();
      const after = await row(first.rowId);
      expect(after.status).toBe('COMPLETE');
      expect(after.subscription).toMatchObject({ status: 'ACTIVE', providerSubId: 'sub_paying' });
    });

    it('does nothing for a late or replayed failure after the debit succeeded', async () => {
      const first = await startCheckout();
      markPaid(first.providerSessionId, { paymentStatus: 'unpaid' });
      await confirm(first.token, first.providerSessionId);
      expect((await completedEvent(first.providerSessionId, 'checkout.session.async_payment_succeeded', 'sub_settled')).statusCode).toBe(200);
      expect((await row(first.rowId)).subscription).toMatchObject({ status: 'ACTIVE', providerSubId: 'sub_settled' });

      const cancel = vi.spyOn(fakeStripe, 'cancelSubscription');
      for (let i = 0; i < 2; i += 1) {
        const hook = await completedEvent(first.providerSessionId, 'checkout.session.async_payment_failed', 'sub_settled');
        expect(hook.statusCode, hook.body).toBe(200);
      }
      expect(cancel).not.toHaveBeenCalled();
      const after = await row(first.rowId);
      expect(after.status).toBe('COMPLETE');
      expect((after.metadata as { paymentFailedAt?: string }).paymentFailedAt).toBeUndefined();
      expect(after.subscription).toMatchObject({ status: 'ACTIVE', providerSubId: 'sub_settled' });
    });

    it('answers 500 when the cancellation fails, and the retried delivery cancels and completes', async () => {
      const first = await startCheckout();
      const cancel = vi
        .spyOn(fakeStripe, 'cancelSubscription')
        .mockRejectedValueOnce(Object.assign(new Error('Stripe is down'), { statusCode: 500, code: 'api_error' }));
      const payload = JSON.stringify({
        id: 'evt_failed_debit_retry',
        object: 'event',
        type: 'checkout.session.async_payment_failed',
        livemode: false,
        data: { object: { id: first.providerSessionId, subscription: 'sub_retry', payment_status: 'unpaid', metadata: { applicationId } } },
      });
      const deliver = () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/billing/webhook/stripe/${slug}`,
          headers: { 'stripe-signature': signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }), 'content-type': 'application/json' },
          payload,
        });

      expect((await deliver()).statusCode).toBe(500);
      const receipt = await prisma.webhookEvent.findFirstOrThrow({ where: { providerEventId: 'evt_failed_debit_retry' } });
      expect(receipt.processedAt).toBeNull();

      const retry = await deliver();
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toMatchObject({ processed: true });
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(cancel.mock.calls[1]![0]).toMatchObject({ atPeriodEnd: false, subscription: { providerSubId: 'sub_retry' } });
      expect((await row(first.rowId)).status).toBe('EXPIRED');
    });

    it('acknowledges the event when the subscription is already gone', async () => {
      const first = await startCheckout();
      vi.spyOn(fakeStripe, 'cancelSubscription').mockRejectedValue(Object.assign(new Error('No such subscription'), { code: 'resource_missing' }));
      const hook = await completedEvent(first.providerSessionId, 'checkout.session.async_payment_failed', 'sub_gone');
      expect(hook.statusCode, hook.body).toBe(200);
      expect((await row(first.rowId)).status).toBe('EXPIRED');
    });
  });

  describe('the hosted fallback', () => {
    function fallback(token: string) {
      return app.inject({ method: 'POST', url: `/api/v1/checkout-sessions/${token}/fallback`, headers: { origin: PORTAL } });
    }

    it('expires the elements session, opens one hosted session for it, and reuses it', async () => {
      const { token, providerSessionId, rowId } = await startCheckout();
      const res = await fallback(token);
      expect(res.statusCode, res.body).toBe(200);
      const url = (res.json().data as { url: string }).url;
      expect(new URL(url).hostname).toBe('checkout.stripe.com');
      expect(fakeStripe.sessions.get(providerSessionId)!.status).toBe('expired');
      expect(fakeStripe.fallbacks).toHaveLength(1);
      expect(fakeStripe.fallbacks[0]).toMatchObject({
        embeddedSessionId: providerSessionId,
        kind: 'recurring',
        successUrl: `${PORTAL}/${slug}/checkout/${token}`,
        cancelUrl: `${PORTAL}/${slug}/checkout/${token}`,
      });

      const after = await row(rowId);
      expect(after.providerSessionId).not.toBe(providerSessionId);
      expect(url).toContain(after.providerSessionId);
      const history = (after.subscription.metadata as { checkoutSessionIds: string[]; checkoutSessionId: string });
      expect(history.checkoutSessionId).toBe(after.providerSessionId);
      expect(history.checkoutSessionIds).toEqual(expect.arrayContaining([providerSessionId, after.providerSessionId]));

      expect(fakeStripe.fallbacks[0]!.expiresAt.getTime()).toBe(after.expiresAt.getTime());
      expect(fakeStripe.fallbacks[0]!.priceId).toBe('price_ci');

      const again = await fallback(token);
      expect((again.json().data as { url: string }).url).toBe(url);
      expect(fakeStripe.fallbacks).toHaveLength(1);
    });

    it('asks Stripe for the hosted URL again on a later click, so a Checkout custom domain keeps working', async () => {
      const { token, rowId } = await startCheckout();
      await fallback(token);
      const hosted = (await row(rowId)).providerSessionId;
      const custom = `https://pay.acme.example/c/pay/${hosted}`;
      fakeStripe.sessions.set(hosted, { ...fakeStripe.sessions.get(hosted)!, url: custom });
      expect(((await fallback(token)).json().data as { url: string }).url).toBe(custom);
      markPaid(hosted);
      expect((await fallback(token)).json().error.code).toBe('CHECKOUT_SESSION_COMPLETE');
    });

    it('expires a hosted session it could not record, so nobody can pay it', async () => {
      const { token, rowId } = await startCheckout();
      const create = fakeStripe.createHostedFallback.bind(fakeStripe);
      vi.spyOn(fakeStripe, 'createHostedFallback').mockImplementation(async (input) => {
        const hosted = await create(input);
        await prisma.checkoutSession.update({ where: { id: rowId }, data: { providerSessionId: 'cs_test_wonTheRace' } });
        return hosted;
      });
      const res = await fallback(token);
      expect(res.json().error.code).toBe('CHECKOUT_FALLBACK_UNAVAILABLE');
      const orphan = [...fakeStripe.sessions.values()].find((s) => s.id.startsWith('cs_test_hosted'))!;
      expect(orphan.status).toBe('expired');
    });

    it('keeps a refusal counted before the fallback', async () => {
      const { token, rowId } = await startCheckout();
      await confirm(token, `cs_test_${'z'.repeat(20)}`);
      await fallback(token);
      const meta = (await row(rowId)).metadata as { refusedConfirmations?: number; fallbackUrl?: string };
      expect(meta.refusedConfirmations).toBe(1);
      expect(meta.fallbackUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    });

    it('moves the coupon reservation to the hosted session', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/coupons`,
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { code: 'tenoff', discountType: 'AMOUNT', currency: 'USD', amountOff: 1000, maxRedemptions: 5 },
      });
      expect(created.statusCode, created.body).toBe(201);
      const { token, providerSessionId, rowId } = await startCheckout(undefined, { couponCode: 'tenoff' });
      expect(await prisma.couponRedemption.count({ where: { applicationId, checkoutSessionId: providerSessionId } })).toBe(1);
      await fallback(token);
      const hosted = (await row(rowId)).providerSessionId;
      expect(await prisma.couponRedemption.count({ where: { applicationId, checkoutSessionId: providerSessionId } })).toBe(0);
      expect(await prisma.couponRedemption.count({ where: { applicationId, checkoutSessionId: hosted } })).toBe(1);
    });

    it('lets the hosted session confirm and complete the same checkout', async () => {
      const { token, rowId } = await startCheckout();
      await fallback(token);
      const hosted = (await row(rowId)).providerSessionId;
      markPaid(hosted);
      expect((await confirm(token, hosted)).json().data).toEqual({ status: 'confirming' });
      expect((await completedEvent(hosted)).statusCode).toBe(200);
      const after = await row(rowId);
      expect(after.status).toBe('COMPLETE');
      expect(after.subscription.status).toBe('ACTIVE');
    });

    it('moves the trial reservation to the hosted session', async () => {
      await prisma.plan.updateMany({ where: { applicationId }, data: { trialDays: 14 } });
      const { token, providerSessionId, rowId } = await startCheckout();
      expect(fakeStripe.lastEmbedded!.trial).toEqual({ days: 14 });
      await fallback(token);
      const hosted = (await row(rowId)).providerSessionId;
      expect(fakeStripe.fallbacks[0]!.trial).toEqual({ days: 14 });
      expect(await prisma.trialRedemption.count({ where: { applicationId, checkoutSessionId: providerSessionId } })).toBe(0);
      expect(await prisma.trialRedemption.count({ where: { applicationId, checkoutSessionId: hosted } })).toBe(1);
    });

    it('refuses once the elements session was paid, and leaves the row alone', async () => {
      const { token, providerSessionId, rowId } = await startCheckout();
      markPaid(providerSessionId);
      const res = await fallback(token);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CHECKOUT_SESSION_COMPLETE');
      expect((await row(rowId)).providerSessionId).toBe(providerSessionId);
    });
  });

  describe('readiness', () => {
    it('falls back to Stripe’s page when the publishable key is missing', async () => {
      await billingCredentialsService.upsertCredentials(applicationId, 'stripe', { publishableKey: '' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': await buyer() },
        payload: { planSlug: 'standard', successUrl: `${REGISTERED}/account?paid=1`, cancelUrl: `${REGISTERED}/account` },
      });
      const data = res.json().data as { mode: string; warnings: Array<{ check?: string }> };
      expect(data.mode).toBe('redirect');
      expect(data.warnings[0]!.check).toBe('browser_credential');
    });

    it('refuses to store a publishable key in the other mode from the secret key', async () => {
      await expect(
        billingCredentialsService.upsertCredentials(applicationId, 'stripe', { publishableKey: 'pk_live_ci_only' }),
      ).rejects.toMatchObject({ code: 'BILLING_CREDENTIALS_INVALID' });
    });
  });
});
