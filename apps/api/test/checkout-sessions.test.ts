/**
 * The Rekey-hosted checkout page, API side: session creation in both
 * presentations, the token lookup, the per-checkout guard with both failure
 * behaviours, the readiness preflight and the per-mode setting.
 *
 * The fake PayPal provider implements `createEmbeddedCheckout`. The portal
 * probe is answered by a stubbed `fetch` that plays the portal's part, calling
 * the API back.
 */

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';

vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();
  return { ...actual, env: { ...actual.env } };
});

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { env } = await import('../src/config/env.js');
const mutableEnv = env as { CHECKOUT_EMBEDDED_ENABLED: boolean };
const { configureSandboxPaypal } = await import('./fakes/billing-credentials.js');
const { billingCredentialsService } = await import('../src/modules/billing/credentials.service.js');
const { fakePaypal } = await import('./fakes/billing-providers.js');
const { redactUrlSecrets } = await import('../src/lib/log-redaction.js');
const { confirmProbeNonce } = await import('../src/modules/billing/checkout/portal-probe.js');

const PASSWORD = 'pw-one-two-three';
const REGISTERED = 'https://app.example';
const PORTAL = new URL(process.env.PUBLIC_PORTAL_URL!).origin;
const realFetch = globalThis.fetch;

type PortalBehaviour = 'confirm' | 'ignore' | 'down' | 'wrong-slug';

describe('hosted checkout sessions', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let slug: string;
  let operatorAccess: string;
  let liveKey: string;
  let userAccess: string;
  let userEmail: string;
  let portalBehaviour: PortalBehaviour;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    mutableEnv.CHECKOUT_EMBEDDED_ENABLED = true;
    portalBehaviour = 'confirm';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== PORTAL) return realFetch(input, init);
      if (portalBehaviour === 'down') throw new TypeError('fetch failed');
      const nonce = url.searchParams.get('n') ?? '';
      if (portalBehaviour === 'confirm') {
        const callback = await app.inject({ method: 'GET', url: `/api/v1/checkout/probe/${nonce}` });
        const probed = (callback.json() as { data?: { slug: string } }).data?.slug;
        const pathSlug = decodeURIComponent(url.pathname.split('/')[1] ?? '');
        if (callback.statusCode !== 200 || probed !== pathSlug) return new Response('{}', { status: 502 });
      }
      if (portalBehaviour === 'wrong-slug') await confirmProbeNonce('x'.repeat(43));
      return new Response(JSON.stringify({ ok: true, cspReports: true }), { status: 200 });
    });

    slug = `hco-${Math.random().toString(36).slice(2, 8)}`;
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
      payload: { slug: 'standard', name: 'Cloud Standard', amount: 9900 },
    });
    expect(plan.statusCode).toBe(201);
    const current = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        authConfig: { ...(current.authConfig as Prisma.JsonObject), appUrl: `${REGISTERED}/account` },
        portalBranding: { displayName: 'Rekey Cloud', logoUrl: 'https://cdn.example/logo.png' },
      },
    });
    userEmail = `eu-${slug}@example.com`;
    userAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: userEmail, password: PASSWORD },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function operator(method: 'GET' | 'PATCH', url: string, payload?: Record<string, unknown>) {
    return app.inject({
      method,
      url: `/api/v1/tenant/applications/${applicationId}${url}`,
      headers: { authorization: `Bearer ${operatorAccess}` },
      ...(payload !== undefined && { payload }),
    });
  }

  /** Switch test-mode checkouts to the Rekey page through the real preflight. */
  async function enableEmbedded(failureMode: 'FALLBACK_TO_REDIRECT' | 'REFUSE' = 'FALLBACK_TO_REDIRECT') {
    const res = await operator('PATCH', '/checkout', { paymentMode: 'test', checkoutMode: 'EMBEDDED', checkoutFailureMode: failureMode });
    expect(res.statusCode, res.body).toBe(200);
  }

  function checkout(extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess, ...headers },
      payload: {
        planSlug: 'standard',
        successUrl: `${REGISTERED}/account?paid=1`,
        cancelUrl: `${REGISTERED}/account`,
        ...extra,
      },
    });
  }

  async function embeddedCheckout(): Promise<{ token: string; url: string; checkoutSessionId: string }> {
    const res = await checkout();
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as { url: string; mode: string; checkoutSessionId: string };
    expect(data.mode).toBe('embedded');
    const token = data.url.split('/').pop()!;
    return { token, url: data.url, checkoutSessionId: data.checkoutSessionId };
  }

  function view(token: string) {
    return app.inject({ method: 'GET', url: `/api/v1/checkout-sessions/${token}` });
  }

  async function securityEvents(type: string) {
    for (let i = 0; i < 20; i++) {
      const rows = await prisma.securityEvent.findMany({ where: { applicationId, type } });
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  }

  describe('creation', () => {
    it('serves the Rekey page when the mode is EMBEDDED and ready, and stores only the token hash', async () => {
      await enableEmbedded();
      const { token, url, checkoutSessionId } = await embeddedCheckout();
      expect(url).toBe(`${PORTAL}/${slug}/checkout/${token}`);
      expect(token).toMatch(/^chk_test_[A-Za-z0-9_-]{43}$/);

      const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutSessionId } });
      expect(row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(row).toMatchObject({ mode: 'EMBEDDED', paymentMode: 'TEST', kind: 'RECURRING', status: 'OPEN', provider: 'paypal' });
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(23 * 60 * 60 * 1000);

      // Nowhere in the database in clear: not the session, the subscription,
      // the idempotency cache, or the audit log.
      const dumps = await prisma.$queryRawUnsafe<Array<{ t: string }>>(
        `SELECT row_to_json(c)::text AS t FROM checkout_sessions c
         UNION ALL SELECT row_to_json(s)::text FROM subscriptions s
         UNION ALL SELECT row_to_json(k)::text FROM idempotency_keys k
         UNION ALL SELECT row_to_json(e)::text FROM security_events e`,
      );
      expect(dumps.length).toBeGreaterThan(0);
      for (const { t } of dumps) expect(t).not.toContain(token.slice(9));

      // The provider was told to send the buyer back to our page.
      expect(fakePaypal.lastEmbedded?.returnUrl).toBe(url);
    });

    it('keeps the provider page and records a token-less row while the mode is REDIRECT', async () => {
      const res = await checkout();
      expect(res.statusCode).toBe(200);
      const data = res.json().data as { url: string; mode: string; checkoutSessionId: string; warnings: unknown[] };
      expect(data.mode).toBe('redirect');
      expect(data.url).not.toContain('/checkout/chk_');
      expect(data.warnings).toEqual([]);
      const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: data.checkoutSessionId } });
      expect(row).toMatchObject({ mode: 'REDIRECT', tokenHash: null, paymentMode: 'TEST' });
    });

    it('honours mode: "redirect" from the caller even when the Rekey page is on', async () => {
      await enableEmbedded();
      const res = await checkout({ mode: 'redirect' });
      expect((res.json().data as { mode: string }).mode).toBe('redirect');
    });

    it('uses the live setting for a checkout on live credentials, and the test setting stays separate', async () => {
      await enableEmbedded();
      await prisma.billingCredentials.update({
        where: { applicationId_provider: { applicationId, provider: 'paypal' } },
        data: { mode: 'live' },
      });
      const res = await checkout();
      const data = res.json().data as { mode: string; checkoutSessionId: string };
      expect(data.mode).toBe('redirect');
      const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: data.checkoutSessionId } });
      expect(row.paymentMode).toBe('LIVE');
    });
  });

  describe('the page lookup', () => {
    it('returns the order, the full email and the browser config while OPEN', async () => {
      await enableEmbedded();
      const { token } = await embeddedCheckout();
      const res = await view(token);
      expect(res.statusCode).toBe(200);
      const data = res.json().data as {
        status: string;
        paymentMode: string;
        slug: string;
        order: { buyerEmail: string; plan: { name: string; amount: number; interval: string }; client: { clientId: string; subscriptionId: string }; merchant: { displayName: string; logoUrl: string } };
      };
      expect(data.status).toBe('open');
      expect(data.slug).toBe(slug);
      expect(data.paymentMode).toBe('test');
      expect(data.order.buyerEmail).toBe(userEmail);
      expect(data.order.plan).toMatchObject({ name: 'Cloud Standard', amount: 9900, interval: 'MONTH' });
      expect(data.order.client.clientId).toBe('client_ci_only');
      expect(data.order.merchant).toMatchObject({ displayName: 'Rekey Cloud', logoUrl: 'https://cdn.example/logo.png' });
      // Nothing secret, and no fallback URL or plan id, reaches the page.
      expect(res.body).not.toContain('secret_ci_only');
      expect(res.body).not.toContain('fallbackUrl');
    });

    it('answers the same 404 for an unknown, a malformed and a re-prefixed token', async () => {
      await enableEmbedded();
      const { token } = await embeddedCheckout();
      const reprefixed = token.replace('chk_test_', 'chk_live_');
      for (const t of [`chk_test_${'A'.repeat(43)}`, 'not-a-token', reprefixed]) {
        const res = await view(t);
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('CHECKOUT_SESSION_NOT_FOUND');
      }
    });

    it('shows no order and no email once the session has expired', async () => {
      await enableEmbedded();
      const { token, checkoutSessionId } = await embeddedCheckout();
      await prisma.checkoutSession.update({ where: { id: checkoutSessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await view(token);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ status: 'expired', order: null, returnUrl: `${REGISTERED}/account` });
      expect(res.body).not.toContain(userEmail);
      expect(res.body).not.toContain('Cloud Standard');
      expect((await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutSessionId } })).status).toBe('EXPIRED');
    });

    it('completes only from the verified webhook, then shows no order and no email', async () => {
      await enableEmbedded();
      const { token, checkoutSessionId } = await embeddedCheckout();
      const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutSessionId } });
      const hook = await app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/paypal/${slug}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          id: `WH-${randomUUID()}`,
          event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resource: { id: row.providerSessionId, status: 'ACTIVE', custom_id: `${applicationId}:${row.endUserId}` },
        }),
      });
      expect(hook.statusCode).toBe(200);
      expect((await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutSessionId } })).status).toBe('COMPLETE');
      const res = await view(token);
      expect(res.json().data).toMatchObject({ status: 'complete', order: null, returnUrl: `${REGISTERED}/account?paid=1` });
      expect(res.body).not.toContain(userEmail);
    });

    it('never expires a CONFIRMING session: it was approved and waits for its webhook', async () => {
      await enableEmbedded();
      const { token, checkoutSessionId } = await embeddedCheckout();
      await prisma.checkoutSession.update({
        where: { id: checkoutSessionId },
        data: { status: 'CONFIRMING', expiresAt: new Date(Date.now() - 60_000) },
      });
      expect((await view(token)).json().data).toMatchObject({ status: 'confirming' });
      expect((await app.inject({ method: 'GET', url: `/api/v1/checkout-sessions/${token}/status` })).json().data).toEqual({
        status: 'confirming',
      });
      expect((await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutSessionId } })).status).toBe('CONFIRMING');
    });

    it('completes an EXPIRED session from the verified webhook, since the buyer paid', async () => {
      await enableEmbedded();
      const { token, checkoutSessionId } = await embeddedCheckout();
      const row = await prisma.checkoutSession.update({
        where: { id: checkoutSessionId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      expect((await view(token)).json().data).toMatchObject({ status: 'expired' });
      const hook = await app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/paypal/${slug}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          id: `WH-${randomUUID()}`,
          event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resource: { id: row.providerSessionId, status: 'ACTIVE', custom_id: `${applicationId}:${row.endUserId}` },
        }),
      });
      expect(hook.statusCode).toBe(200);
      expect((await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutSessionId } })).status).toBe('COMPLETE');
      expect((await view(token)).json().data).toMatchObject({ status: 'complete' });
    });

    it('refuses a disabled Application with the same 404', async () => {
      await enableEmbedded();
      const { token } = await embeddedCheckout();
      await prisma.application.update({ where: { id: applicationId }, data: { disabledAt: new Date() } });
      expect((await view(token)).statusCode).toBe(404);
    });

    it('never returns a fallback URL off the provider host, and refuses a cross-site POST', async () => {
      await enableEmbedded();
      const { token, checkoutSessionId } = await embeddedCheckout();
      const ok = await app.inject({ method: 'POST', url: `/api/v1/checkout-sessions/${token}/fallback` });
      expect(ok.statusCode).toBe(200);
      expect(new URL((ok.json().data as { url: string }).url).hostname).toBe('www.sandbox.paypal.com');

      const crossSite = await app.inject({
        method: 'POST',
        url: `/api/v1/checkout-sessions/${token}/fallback`,
        headers: { origin: 'https://evil.example' },
      });
      expect(crossSite.statusCode).toBe(403);

      const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutSessionId } });
      await prisma.checkoutSession.update({
        where: { id: checkoutSessionId },
        data: { metadata: { ...(row.metadata as Prisma.JsonObject), fallbackUrl: 'https://evil.example/paypal.com' } },
      });
      const tampered = await app.inject({ method: 'POST', url: `/api/v1/checkout-sessions/${token}/fallback` });
      expect(tampered.statusCode).toBe(409);
      expect(tampered.json().error.code).toBe('CHECKOUT_FALLBACK_UNAVAILABLE');
    });

    it('rate-limits polling per token', async () => {
      await enableEmbedded();
      const { token } = await embeddedCheckout();
      const codes: number[] = [];
      for (let i = 0; i < 42; i++) {
        codes.push((await app.inject({ method: 'GET', url: `/api/v1/checkout-sessions/${token}/status` })).statusCode);
      }
      expect(codes.slice(0, 40).every((c) => c === 200)).toBe(true);
      expect(codes.slice(40)).toEqual([429, 429]);
    });
  });

  describe('test and live', () => {
    it('refuses and expires a test session after the credentials moved to live, and back', async () => {
      await enableEmbedded();
      const { token, checkoutSessionId } = await embeddedCheckout();
      await prisma.billingCredentials.update({
        where: { applicationId_provider: { applicationId, provider: 'paypal' } },
        data: { mode: 'live' },
      });
      const refused = await view(token);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('CHECKOUT_MODE_MISMATCH');
      expect((await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutSessionId } })).status).toBe('EXPIRED');
      // Switching back does not revive it.
      await prisma.billingCredentials.update({
        where: { applicationId_provider: { applicationId, provider: 'paypal' } },
        data: { mode: 'test' },
      });
      expect((await view(token)).json().data).toMatchObject({ status: 'expired', order: null });
      expect(await securityEvents('app.checkout_mode_mismatch')).toHaveLength(1);
    });

    it('does not apply a completion verified in the other mode', async () => {
      await enableEmbedded();
      const { checkoutSessionId } = await embeddedCheckout();
      const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutSessionId } });
      await prisma.billingCredentials.update({
        where: { applicationId_provider: { applicationId, provider: 'paypal' } },
        data: { mode: 'live' },
      });
      const hook = await app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/paypal/${slug}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          id: `WH-${randomUUID()}`,
          event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
          resource: { id: row.providerSessionId, status: 'ACTIVE' },
        }),
      });
      expect(hook.statusCode).toBe(200);
      const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: row.subscriptionId } });
      expect(sub.status).toBe('PENDING');
      expect((await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutSessionId } })).status).toBe('EXPIRED');
      const receipt = await prisma.webhookEvent.findFirstOrThrow({ where: { applicationId, eventType: 'BILLING.SUBSCRIPTION.ACTIVATED' } });
      expect(receipt.processedAt).not.toBeNull();
      expect(receipt.mode).toBe('live');
      expect(receipt.processingError).toContain('CHECKOUT_MODE_MISMATCH');
      const events = await securityEvents('app.checkout_mode_mismatch');
      expect(events.map((e) => (e.metadata as { at?: string }).at)).toEqual(['completion']);
    });
  });

  describe('the per-checkout guard', () => {
    it('falls back to the provider page with a warning and one security event when a check fails', async () => {
      await enableEmbedded('FALLBACK_TO_REDIRECT');
      await prisma.billingCredentials.deleteMany({ where: { applicationId } });
      await billingCredentialsService.upsertCredentials(
        applicationId,
        'paypal',
        { clientId: 'client_ci_only', clientSecret: 'secret_ci_only' },
        { mode: 'test' },
      );
      const res = await checkout();
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data as { mode: string; warnings: Array<{ code: string; check: string; fix: string }> };
      expect(data.mode).toBe('redirect');
      expect(data.warnings).toEqual([expect.objectContaining({ code: 'CHECKOUT_EMBEDDED_FELL_BACK', check: 'webhook' })]);
      // The buyer-facing warning names only the check; the operator's log has the detail.
      expect(res.body).not.toContain('Billing providers → PayPal');
      expect(res.body).not.toContain('Auto-configure');
      expect(data.warnings[0]!.fix).toContain('Panel → Application → Billing → Checkout page');
      const events = await securityEvents('app.checkout_embedded_fallback');
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ check: 'webhook', provider: 'paypal', paymentMode: 'test' });
      expect(String((events[0]!.metadata as { fix?: string }).fix)).toContain('Billing providers → PayPal');
    });

    it('falls back when the PayPal client ID the buttons need is missing', async () => {
      await enableEmbedded();
      await billingCredentialsService.upsertRaw(
        applicationId,
        'paypal',
        { clientSecret: 'secret_ci_only', webhookId: 'WH-ci-only' },
        { mode: 'test' },
      );
      const data = (await checkout()).json().data as { mode: string; warnings: Array<{ check?: string }> };
      expect(data.mode).toBe('redirect');
      expect(data.warnings[0]!.check).toBe('browser_credential');
    });

    it('falls back when the provider cannot take this flow on the page', async () => {
      await enableEmbedded();
      await billingCredentialsService.upsertRaw(
        applicationId,
        'razorpay',
        { keyId: 'rzp_test_ci', keySecret: 'secret', webhookSecret: 'whsec' },
        { mode: 'test' },
      );
      const data = (await checkout({ provider: 'razorpay' })).json().data as { mode: string; warnings: Array<{ check?: string }> };
      expect(data.mode).toBe('redirect');
      expect(data.warnings[0]!.check).toBe('provider');
    });

    it('falls back when a return URL is on an unregistered origin', async () => {
      await enableEmbedded();
      const res = await checkout({ successUrl: 'https://elsewhere.example/ok' });
      const data = res.json().data as { mode: string; warnings: Array<{ code: string; check?: string }> };
      expect(data.mode).toBe('redirect');
      expect(data.warnings.map((w) => w.code).sort()).toEqual(['CHECKOUT_EMBEDDED_FELL_BACK', 'CHECKOUT_RETURN_URL_UNREGISTERED']);
      expect(data.warnings.find((w) => w.code === 'CHECKOUT_EMBEDDED_FELL_BACK')!.check).toBe('return_urls');
    });

    it('falls back when the plan is registered in the other mode', async () => {
      await enableEmbedded();
      await prisma.plan.updateMany({ where: { applicationId }, data: { metadata: { paypal: { planId: 'P-LIVE', mode: 'live' } } } });
      const data = (await checkout()).json().data as { mode: string; warnings: Array<{ check?: string }> };
      expect(data.mode).toBe('redirect');
      expect(data.warnings[0]!.check).toBe('plans');
    });

    it('falls back when the portal was never probed successfully', async () => {
      await enableEmbedded();
      await prisma.application.update({ where: { id: applicationId }, data: { checkoutReadiness: { probe: { status: 'FAIL', message: 'down', fix: 'x', cspReports: false, at: new Date().toISOString() } } } });
      const data = (await checkout()).json().data as { mode: string; warnings: Array<{ check?: string }> };
      expect(data.mode).toBe('redirect');
      expect(data.warnings[0]!.check).toBe('portal');
    });

    it('refuses with 409 and creates nothing when the failure behaviour is REFUSE', async () => {
      await enableEmbedded('REFUSE');
      await prisma.application.update({ where: { id: applicationId }, data: { checkoutReadiness: Prisma.DbNull } });
      const spy = vi.spyOn(fakePaypal, 'createEmbeddedCheckout');
      const spyRedirect = vi.spyOn(fakePaypal, 'createCheckoutSession');
      const res = await checkout();
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CHECKOUT_EMBEDDED_NOT_READY');
      expect(res.json().error.message).toBe('This checkout cannot be taken right now.');
      expect(res.json().error.details).toEqual({ check: 'portal' });
      expect(res.body).not.toContain('probed');
      const refusals = await securityEvents('app.checkout_embedded_refused');
      expect(refusals.map((e) => (e.metadata as { check: string }).check)).toEqual(['portal']);
      expect(spy).not.toHaveBeenCalled();
      expect(spyRedirect).not.toHaveBeenCalled();
      expect(await prisma.subscription.count({ where: { applicationId } })).toBe(0);
      expect(await prisma.checkoutSession.count({ where: { applicationId } })).toBe(0);
    });

    it('treats the kill switch as a failed check under both behaviours', async () => {
      await enableEmbedded('FALLBACK_TO_REDIRECT');
      mutableEnv.CHECKOUT_EMBEDDED_ENABLED = false;
      const fell = (await checkout()).json().data as { mode: string; warnings: Array<{ check?: string; fix: string }> };
      expect(fell.mode).toBe('redirect');
      expect(fell.warnings[0]!.check).toBe('portal');
      expect(JSON.stringify(fell)).not.toContain('CHECKOUT_EMBEDDED_ENABLED');

      await prisma.application.update({ where: { id: applicationId }, data: { checkoutFailureMode: 'REFUSE' } });
      const refused = await checkout();
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('CHECKOUT_EMBEDDED_NOT_READY');
    });
  });

  describe('the per-IP and per-Application creation ceilings', () => {
    const limits = env as { CHECKOUT_LIMIT_PER_IP_HOUR: number; CHECKOUT_LIMIT_PER_APP_HOUR: number };
    const saved = { ip: limits.CHECKOUT_LIMIT_PER_IP_HOUR, app: limits.CHECKOUT_LIMIT_PER_APP_HOUR };
    beforeEach(() => {
      process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = '1';
    });
    afterEach(() => {
      delete process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
      limits.CHECKOUT_LIMIT_PER_IP_HOUR = saved.ip;
      limits.CHECKOUT_LIMIT_PER_APP_HOUR = saved.app;
    });

    async function freshBuyer(): Promise<string> {
      return app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${liveKey}` },
          payload: { email: `eu-${randomUUID()}@example.com`, password: PASSWORD },
        })
        .then((r) => (r.json().data as { accessToken: string }).accessToken);
    }

    function checkoutFrom(token: string, remoteAddress: string) {
      return app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        remoteAddress,
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': token },
        payload: { planSlug: 'standard', successUrl: `${REGISTERED}/account?paid=1`, cancelUrl: `${REGISTERED}/account` },
      });
    }

    it('stops fresh accounts from one address at the per-IP ceiling', async () => {
      limits.CHECKOUT_LIMIT_PER_IP_HOUR = 3;
      for (let i = 0; i < 3; i++) expect((await checkoutFrom(await freshBuyer(), '203.0.113.9')).statusCode).toBe(200);
      const refused = await checkoutFrom(await freshBuyer(), '203.0.113.9');
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.code).toBe('CHECKOUT_RATE_LIMITED');
      expect(refused.json().error.message).toContain('from this network address');
      expect((await checkoutFrom(await freshBuyer(), '203.0.113.10')).statusCode).toBe(200);
    });

    it('stops fresh accounts spread over addresses at the per-Application ceiling', async () => {
      limits.CHECKOUT_LIMIT_PER_APP_HOUR = 3;
      for (let i = 0; i < 3; i++) expect((await checkoutFrom(await freshBuyer(), `203.0.113.${20 + i}`)).statusCode).toBe(200);
      const refused = await checkoutFrom(await freshBuyer(), '203.0.113.40');
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.message).toContain('for this Application');
    });

    it('gives back the slots already taken when a later ceiling refuses', async () => {
      limits.CHECKOUT_LIMIT_PER_APP_HOUR = 1;
      const buyer = await freshBuyer();
      expect((await checkoutFrom(await freshBuyer(), '203.0.113.50')).statusCode).toBe(200);
      for (let i = 0; i < 12; i++) expect((await checkoutFrom(buyer, '203.0.113.51')).statusCode).toBe(429);
      limits.CHECKOUT_LIMIT_PER_APP_HOUR = 1000;
      expect((await checkoutFrom(buyer, '203.0.113.51')).statusCode).toBe(200);
    });
  });

  describe('the per-end-user creation limit', () => {
    it('admits ten checkouts an hour and answers the eleventh with CHECKOUT_RATE_LIMITED', async () => {
      for (let i = 0; i < 10; i++) expect((await checkout()).statusCode).toBe(200);
      const res = await checkout();
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('CHECKOUT_RATE_LIMITED');
      expect(res.json().error.fix).toMatch(/Retry after \d{4}-\d\d-\d\dT/);
    });

    it('admits exactly ten of twelve concurrent checkouts', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, () => checkout()));
      const codes = results.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 200)).toHaveLength(10);
      expect(codes.filter((c) => c === 429)).toHaveLength(2);
    });

    it('gives the slot back when the checkout fails', async () => {
      for (let i = 0; i < 12; i++) {
        const res = await checkout({ planSlug: 'no-such-plan' });
        expect(res.statusCode).toBe(404);
      }
      expect((await checkout()).statusCode).toBe(200);
    });
  });

  describe('readiness and the setting', () => {
    it('reports the test column and marks live N/A for a sandbox-only Application', async () => {
      const res = await operator('GET', '/checkout/readiness');
      expect(res.statusCode).toBe(200);
      const data = res.json().data as { test: Array<{ id: string; status: string; fix: string | null }>; live: Array<{ status: string; fix: string }> };
      expect(data.live).toEqual([expect.objectContaining({ status: 'N/A' })]);
      expect(data.live[0]!.fix).toContain('Add live credentials');
      const byId = Object.fromEntries(data.test.map((c) => [c.id, c.status]));
      expect(byId).toMatchObject({ portal: 'PASS', provider: 'PASS', webhook: 'WARN', plans: 'PASS', return_urls: 'PASS', browser_credential: 'PASS', branding: 'PASS', csp_reports: 'PASS' });
    });

    it('FAILs live webhook evidence where the test column only WARNs', async () => {
      await prisma.billingCredentials.update({
        where: { applicationId_provider: { applicationId, provider: 'paypal' } },
        data: { mode: 'live' },
      });
      await prisma.application.update({ where: { id: applicationId }, data: { environment: 'PRODUCTION' } });
      const data = (await operator('GET', '/checkout/readiness')).json().data as { live: Array<{ id: string; status: string; fix: string }> };
      const webhook = data.live.find((c) => c.id === 'webhook')!;
      expect(webhook.status).toBe('FAIL');
      expect(webhook.fix).toBe(
        "Check the webhook in Panel → Application → Billing → Billing providers → PayPal, then complete one checkout on the provider's page so an event arrives.",
      );
      const refused = await operator('PATCH', '/checkout', { paymentMode: 'live', checkoutMode: 'EMBEDDED' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('CHECKOUT_READINESS_FAILED');
      expect((await prisma.application.findUniqueOrThrow({ where: { id: applicationId } })).checkoutModeLive).toBe('REDIRECT');

      const liveEvent = (mode: string | null, receivedAt = new Date(), processingError: string | null = null) =>
        prisma.webhookEvent.create({
          data: { applicationId, provider: 'paypal', providerEventId: `WH-${randomUUID()}`, eventType: 'PAYMENT.SALE.COMPLETED', payload: {}, mode, receivedAt, processingError },
        });
      const switchLive = async () => {
        await prisma.application.update({ where: { id: applicationId }, data: { checkoutReadinessAt: null } });
        return (await operator('PATCH', '/checkout', { paymentMode: 'live', checkoutMode: 'EMBEDDED' })).statusCode;
      };
      // A sandbox delivery, and one from before the mode was recorded, prove nothing about live.
      await liveEvent('test');
      await liveEvent(null);
      expect(await switchLive()).toBe(409);
      // A live delivery verified with credentials since replaced proves nothing either.
      const creds = await prisma.billingCredentials.findUniqueOrThrow({ where: { applicationId_provider: { applicationId, provider: 'paypal' } } });
      await liveEvent('live', new Date(creds.updatedAt.getTime() - 60_000));
      expect(await switchLive()).toBe(409);
      // Refused because the event's own mode contradicted these credentials:
      // the saved secret is the other mode's endpoint, so it proves the opposite.
      await liveEvent('live', new Date(), 'WEBHOOK_MODE_MISMATCH: a test-mode event was verified by this credential');
      expect(await switchLive()).toBe(409);
      // An event that verified and then failed to apply still proves delivery.
      await liveEvent('live', new Date(), 'Plan "enterprise" not found');
      expect(await switchLive()).toBe(200);
      await prisma.webhookEvent.deleteMany({ where: { applicationId, processingError: { not: null } } });
      await liveEvent('live');
      expect(await switchLive()).toBe(200);
    });

    it('WARNs a sandbox credential on a PRODUCTION Application without blocking', async () => {
      await prisma.application.update({ where: { id: applicationId }, data: { environment: 'PRODUCTION' } });
      const data = (await operator('GET', '/checkout/readiness')).json().data as { test: Array<{ id: string; status: string }> };
      expect(data.test.find((c) => c.id === 'provider')!.status).toBe('WARN');
      expect((await operator('PATCH', '/checkout', { paymentMode: 'test', checkoutMode: 'EMBEDDED' })).statusCode).toBe(200);
    });

    it('refuses the switch when the portal does not call back, and always allows switching back', async () => {
      portalBehaviour = 'ignore';
      const refused = await operator('PATCH', '/checkout', { paymentMode: 'test', checkoutMode: 'EMBEDDED' });
      expect(refused.statusCode).toBe(409);
      const portal = (refused.json().error.details as { checks: Array<{ id: string; status: string }> }).checks.find((c) => c.id === 'portal');
      expect(portal?.status).toBe('FAIL');

      await prisma.application.update({ where: { id: applicationId }, data: { checkoutModeTest: 'EMBEDDED' } });
      const back = await operator('PATCH', '/checkout', { paymentMode: 'test', checkoutMode: 'REDIRECT' });
      expect(back.statusCode).toBe(200);
      expect(back.json().data).toMatchObject({ checkoutModeTest: 'REDIRECT' });
    });

    it('FAILs the probe when the portal is down, and when the callback names another slug', async () => {
      portalBehaviour = 'down';
      let data = (await operator('GET', '/checkout/readiness')).json().data as { test: Array<{ id: string; status: string; fix: string }> };
      expect(data.test.find((c) => c.id === 'portal')).toMatchObject({ status: 'FAIL' });
      expect(data.test.find((c) => c.id === 'portal')!.fix).toContain('can reach the API');

      portalBehaviour = 'wrong-slug';
      await prisma.application.update({ where: { id: applicationId }, data: { checkoutReadinessAt: null } });
      data = (await operator('GET', '/checkout/readiness')).json().data as { test: Array<{ id: string; status: string; fix: string }> };
      expect(data.test.find((c) => c.id === 'portal')!.status).toBe('FAIL');
    });

    it('makes a probe nonce single-use', async () => {
      let nonce = '';
      const codes: number[] = [];
      vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
        nonce = new URL(String(input)).searchParams.get('n') ?? '';
        codes.push((await app.inject({ method: 'GET', url: `/api/v1/checkout/probe/${nonce}` })).statusCode);
        codes.push((await app.inject({ method: 'GET', url: `/api/v1/checkout/probe/${nonce}` })).statusCode);
        return new Response('{"cspReports":true}', { status: 200 });
      });
      await operator('GET', '/checkout/readiness');
      expect(nonce).not.toBe('');
      expect(codes).toEqual([200, 404]);
      expect((await app.inject({ method: 'GET', url: `/api/v1/checkout/probe/${nonce}` })).statusCode).toBe(404);
    });

    it('requires paymentMode with checkoutMode, and rejects unknown keys', async () => {
      expect((await operator('PATCH', '/checkout', { checkoutMode: 'EMBEDDED' })).statusCode).toBe(400);
      expect((await operator('PATCH', '/checkout', { checkoutModeLive: 'EMBEDDED' })).statusCode).toBe(400);
    });

    it('records the setting change as a security event', async () => {
      await operator('PATCH', '/checkout', { checkoutFailureMode: 'REFUSE' });
      expect(await securityEvents('app.checkout_settings_updated')).toHaveLength(1);
    });
  });

  it('keeps checkout tokens out of logged URLs', () => {
    const token = `chk_live_${'a'.repeat(43)}`;
    expect(redactUrlSecrets(`/api/v1/checkout-sessions/${token}/status`)).toBe('/api/v1/checkout-sessions/chk_live_[REDACTED]/status');
  });
});
