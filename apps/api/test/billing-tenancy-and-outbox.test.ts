/**
 * Regressions for the three FIX-NOW findings in #298.
 *
 *  1. Cross-tenant billing key collision. `webhook_events` was UNIQUE(provider,
 *     providerEventId) and `payments.provider_payment_id` was globally UNIQUE,
 *     so two Applications sharing one provider account collided on the same
 *     `evt_…` / charge id: the second tenant's genuine event was answered 200
 *     {processed:false, reason:"duplicate"}, the provider stopped retrying, and
 *     the applier's P2002 recovery handed the FIRST tenant's payment id back.
 *
 *  2. Outbound events lost before reaching the outbox. Delivery rows were
 *     written by a detached `void (async () => …)()` AFTER the money
 *     transaction committed, so a crash in that gap lost the event with no row
 *     for the poller to recover.
 *
 *  3. No timeout on the provider calls. Eleven bare `fetch()` in
 *     providers/paypal.ts, the sharpest of them on the inbound-webhook request
 *     path; Razorpay's SDK constructed with axios `timeout: 0`; Stripe on the
 *     SDK's 80s default.
 *
 * Both applications here are wired to the SAME provider account (same webhook
 * secret, same event ids) on purpose — that is the mundane configuration the
 * finding is about (staging + production, or a cloned app), not an attack.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import {
  enqueueEvent,
  setDeliveryScheduler,
} from '../src/modules/webhooks/webhook.service.js';
import { verifyPaypalWebhook } from '../src/modules/billing/providers/paypal.js';
import { RealRazorpayProvider } from '../src/modules/billing/providers/razorpay.js';
import { RealStripeProvider } from '../src/modules/billing/providers/stripe-real.js';
import { getModule } from '../src/modules/billing/providers/registry.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
// One provider account, two Applications — so both verify against this.
const WEBHOOK_SECRET = 'whsec_shared_between_two_apps';

const stripe = new Stripe('sk_for_signing_only', {
  apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
});

function signed(body: object): { payload: string; headers: Record<string, string> } {
  const payload = JSON.stringify(body);
  return {
    payload,
    headers: {
      'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
      'content-type': 'application/json',
    },
  };
}

interface App {
  id: string;
  slug: string;
  liveKey: string;
  planId: string;
  endUserId: string;
}

describe('Cross-tenant billing keys + transactional outbox', () => {
  let app: FastifyInstance;
  let appA: App;
  let appB: App;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Tenant + Application + BYO Stripe creds + plan + end-user. */
  async function bootstrap(slug: string, email: string): Promise<App> {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: slug, ownerEmail: `${slug}@example.com` },
      })
      .then((r) => r.json().data as { id: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: slug, slug, enableBilling: true },
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

    // The same credentials for both apps — one provider account, two tenants.
    await billingCredentialsService.upsertCredentials(
      application.id,
      'stripe',
      { apiKey: 'sk_test_for_ci_only', webhookSecret: WEBHOOK_SECRET },
      { enabled: true, mode: 'test' },
    );

    const plan = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/plans`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { slug: 'pro_monthly', name: 'Pro', amount: 999 },
      })
      .then((r) => r.json().data as { id: string });

    const su = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${key.rawKey}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    const endUser = await prisma.endUser.findFirstOrThrow({
      where: { applicationId: application.id },
    });
    expect(su.statusCode).toBe(201);

    return {
      id: application.id,
      slug,
      liveKey: key.rawKey,
      planId: plan.id,
      endUserId: endUser.id,
    };
  }

  beforeEach(async () => {
    appA = await bootstrap('tenancy-a', 'a@example.com');
    appB = await bootstrap('tenancy-b', 'b@example.com');
  });

  // ---------------------------------------------------------------- 1 ------

  describe('cross-tenant provider keys', () => {
    it('two applications sharing one provider account both ingest the same event id', async () => {
      const evt = (applicationId: string): object => ({
        id: 'evt_shared_account',
        object: 'event',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_shared', metadata: { applicationId } } },
      });

      const a = signed(evt(appA.id));
      const first = await app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/stripe/${appA.slug}`,
        headers: a.headers,
        payload: a.payload,
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ received: true, processed: true });

      // The SAME provider event id, arriving for the OTHER application. This
      // is the one that used to be answered `{processed:false,
      // reason:"duplicate"}` — after which Stripe stops retrying and the event
      // is gone.
      const b = signed(evt(appB.id));
      const second = await app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/stripe/${appB.slug}`,
        headers: b.headers,
        payload: b.payload,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ received: true, processed: true });

      const rows = await prisma.webhookEvent.findMany({
        where: { providerEventId: 'evt_shared_account' },
        orderBy: { receivedAt: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.applicationId).sort()).toEqual([appA.id, appB.id].sort());
      expect(rows.every((r) => r.processedAt !== null)).toBe(true);
    });

    it('a replay within ONE application is still a duplicate', async () => {
      const { payload, headers } = signed({
        id: 'evt_replay',
        object: 'event',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_replay', metadata: { applicationId: appA.id } } },
      });
      const url = `/api/v1/billing/webhook/stripe/${appA.slug}`;
      expect((await app.inject({ method: 'POST', url, headers, payload })).json()).toMatchObject({
        processed: true,
      });
      expect((await app.inject({ method: 'POST', url, headers, payload })).json()).toMatchObject({
        processed: false,
        reason: 'duplicate',
      });
      expect(
        await prisma.webhookEvent.count({ where: { providerEventId: 'evt_replay' } }),
      ).toBe(1);
    });

    it('the same charge id records a Payment in each application, scoped to its own', async () => {
      // A local subscription per app, both with the provider subscription id
      // the shared account would issue.
      for (const a of [appA, appB]) {
        await prisma.subscription.create({
          data: {
            applicationId: a.id,
            endUserId: a.endUserId,
            planId: a.planId,
            status: 'PENDING',
            providerSubId: 'sub_shared_account',
          },
        });
      }

      const invoice = (applicationId: string, eventId: string): object => ({
        id: eventId,
        object: 'event',
        type: 'invoice.paid',
        data: {
          object: {
            // The SAME charge id for both — one provider account issues one id.
            id: 'in_shared_charge',
            subscription: 'sub_shared_account',
            amount_paid: 999,
            currency: 'usd',
            metadata: { applicationId },
          },
        },
      });

      for (const [a, eventId] of [
        [appA, 'evt_inv_a'],
        [appB, 'evt_inv_b'],
      ] as const) {
        const { payload, headers } = signed(invoice(a.id, eventId));
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/billing/webhook/stripe/${a.slug}`,
          headers,
          payload,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ processed: true });
      }

      const payments = await prisma.payment.findMany({
        where: { providerPaymentId: 'in_shared_charge' },
      });
      expect(payments).toHaveLength(2);
      expect(payments.map((p) => p.applicationId).sort()).toEqual([appA.id, appB.id].sort());
      // Each payment is linked to a subscription in ITS OWN application — the
      // symptom of the old global key was tenant B's event resolving onto
      // tenant A's row.
      for (const p of payments) {
        const sub = await prisma.subscription.findUniqueOrThrow({
          where: { id: p.subscriptionId! },
        });
        expect(sub.applicationId).toBe(p.applicationId);
        expect(p.endUserId).toBe(sub.endUserId);
      }
    });
  });

  // ---------------------------------------------------------------- 2 ------

  describe('transactional outbox', () => {
    /**
     * A scheduler that records what it was asked to attempt and does nothing.
     * Installed so the assertions below see the ROWS, with no delivery attempt
     * racing them, and no dependence on a poll loop.
     */
    let kicked: string[];
    beforeEach(() => {
      kicked = [];
      setDeliveryScheduler((deliveryId) => {
        kicked.push(deliveryId);
      });
    });
    afterEach(() => {
      setDeliveryScheduler(null);
    });

    async function subscribeAll(applicationId: string): Promise<string> {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          applicationId,
          // Never reached: the scheduler above is a no-op.
          url: 'https://127.0.0.1:1/never',
          events: ['*'],
          secret: 'whsec_outbox_test',
          enabled: true,
        },
      });
      return endpoint.id;
    }

    it('enqueueEvent joins the caller transaction — a rollback writes no rows', async () => {
      const endpointId = await subscribeAll(appA.id);

      await expect(
        prisma.$transaction(async (tx) => {
          const ids = await enqueueEvent(tx, {
            applicationId: appA.id,
            type: 'payment.succeeded',
            data: { payment: { id: 'p_rolled_back' } },
          });
          expect(ids).toHaveLength(1);
          throw new Error('caller failed after enqueue');
        }),
      ).rejects.toThrow('caller failed after enqueue');

      expect(await prisma.webhookDelivery.count({ where: { endpointId } })).toBe(0);
    });

    it('enqueueEvent commits with the caller transaction', async () => {
      const endpointId = await subscribeAll(appA.id);

      const ids = await prisma.$transaction((tx) =>
        enqueueEvent(tx, {
          applicationId: appA.id,
          type: 'payment.succeeded',
          data: { payment: { id: 'p_committed' } },
        }),
      );

      const rows = await prisma.webhookDelivery.findMany({ where: { endpointId } });
      expect(rows.map((r) => r.id)).toEqual(ids);
      expect(rows[0]).toMatchObject({ status: 'PENDING', attempts: 0 });
      // Written but not yet attempted: `nextAttemptAt` is in the past, which is
      // what lets the poller recover the row when the kick is lost.
      expect(rows[0]!.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('the payment.succeeded delivery row exists the moment the webhook returns', async () => {
      const endpointId = await subscribeAll(appA.id);
      await prisma.subscription.create({
        data: {
          applicationId: appA.id,
          endUserId: appA.endUserId,
          planId: appA.planId,
          status: 'PENDING',
          providerSubId: 'sub_outbox',
        },
      });

      const { payload, headers } = signed({
        id: 'evt_outbox_paid',
        object: 'event',
        type: 'invoice.paid',
        data: {
          object: {
            id: 'in_outbox',
            subscription: 'sub_outbox',
            amount_paid: 999,
            currency: 'usd',
            metadata: { applicationId: appA.id },
          },
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/stripe/${appA.slug}`,
        headers,
        payload,
      });
      expect(res.statusCode).toBe(200);

      // NO polling. The delivery rows were written inside the same
      // transaction as the Payment, so they are visible by the time the
      // handler responded. Under the old detached emit this read raced an
      // async task that had not started.
      const rows = await prisma.webhookDelivery.findMany({ where: { endpointId } });
      const types = rows.map((r) => r.eventType).sort();
      expect(types).toContain('payment.succeeded');
      expect(types).toContain('subscription.activated');
      // Every row was also handed to the scheduler, post-commit.
      expect(kicked.sort()).toEqual(rows.map((r) => r.id).sort());
    });

    it('a replayed payment writes no second delivery row', async () => {
      const endpointId = await subscribeAll(appA.id);
      await prisma.subscription.create({
        data: {
          applicationId: appA.id,
          endUserId: appA.endUserId,
          planId: appA.planId,
          status: 'PENDING',
          providerSubId: 'sub_outbox_replay',
        },
      });

      const send = async (eventId: string): Promise<number> => {
        const { payload, headers } = signed({
          id: eventId,
          object: 'event',
          type: 'invoice.paid',
          data: {
            object: {
              id: 'in_outbox_replay',
              subscription: 'sub_outbox_replay',
              amount_paid: 999,
              currency: 'usd',
              metadata: { applicationId: appA.id },
            },
          },
        });
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/billing/webhook/stripe/${appA.slug}`,
          headers,
          payload,
        });
        return res.statusCode;
      };

      expect(await send('evt_outbox_replay_1')).toBe(200);
      const afterFirst = await prisma.webhookDelivery.count({ where: { endpointId } });
      // A DIFFERENT event id carrying the SAME charge — the P2002 replay path.
      expect(await send('evt_outbox_replay_2')).toBe(200);
      expect(await prisma.webhookDelivery.count({ where: { endpointId } })).toBe(afterFirst);
      expect(await prisma.payment.count({ where: { providerPaymentId: 'in_outbox_replay' } })).toBe(1);
    });
  });

  // ---------------------------------------------------------------- 3 ------

  describe('provider call timeouts', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('a wedged PayPal fails the verification within the request-path budget', async () => {
      // A server that accepts and never answers. The only thing that ends this
      // is the AbortSignal the fix attaches.
      vi.stubGlobal(
        'fetch',
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('The operation was aborted')),
            );
          }),
      );

      const started = Date.now();
      const outcome = await verifyPaypalWebhook({
        creds: { clientId: 'id', clientSecret: 'secret', webhookId: 'wh' },
        mode: 'test',
        headers: {
          'paypal-transmission-id': 't',
          'paypal-transmission-time': 'now',
          'paypal-cert-url': 'https://example.invalid/cert',
          'paypal-auth-algo': 'SHA256withRSA',
          'paypal-transmission-sig': 'sig',
        },
        event: { id: 'evt' },
      });
      const elapsed = Date.now() - started;

      // Fail-closed, and reported as an outage rather than a bad signature.
      expect(outcome).toEqual({ ok: false, reason: 'unreachable' });
      // Comfortably above the 4s budget, comfortably below "forever" — before
      // the fix this promise never settled at all.
      expect(elapsed).toBeLessThan(10_000);
    });

    it('an unreachable PayPal surfaces as 503, not 401 signature-invalid', async () => {
      vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
      const paypal = getModule('paypal')!;
      const result = await paypal.webhook.verify(
        {
          rawBody: '{}',
          headers: {
            'paypal-transmission-id': 't',
            'paypal-transmission-time': 'now',
            'paypal-cert-url': 'https://example.invalid/cert',
            'paypal-auth-algo': 'SHA256withRSA',
            'paypal-transmission-sig': 'sig',
          },
          payload: { id: 'evt' },
          params: {},
        },
        { clientId: 'id', clientSecret: 'secret', webhookId: 'wh' },
        { mode: 'test' },
      );
      expect(result).toMatchObject({
        ok: false,
        statusCode: 503,
        code: 'WEBHOOK_VERIFICATION_UNAVAILABLE',
      });
    });

    it('a genuinely bad PayPal signature is still 401', async () => {
      vi.stubGlobal('fetch', (url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url.includes('oauth2/token')
                ? { access_token: 'tok' }
                : { verification_status: 'FAILURE' },
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
      const paypal = getModule('paypal')!;
      const result = await paypal.webhook.verify(
        {
          rawBody: '{}',
          headers: {
            'paypal-transmission-id': 't',
            'paypal-transmission-time': 'now',
            'paypal-cert-url': 'https://example.invalid/cert',
            'paypal-auth-algo': 'SHA256withRSA',
            'paypal-transmission-sig': 'sig',
          },
          payload: { id: 'evt' },
          params: {},
        },
        { clientId: 'id', clientSecret: 'secret', webhookId: 'wh' },
        { mode: 'test' },
      );
      expect(result).toMatchObject({ ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' });
      expect((result as { statusCode?: number }).statusCode).toBeUndefined();
    });

    it('every PayPal management call carries an abort deadline', async () => {
      const signals: unknown[] = [];
      vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
        signals.push(init?.signal);
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600, id: 'x' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      });
      const { RealPaypalProvider } = await import('../src/modules/billing/providers/paypal.js');
      const provider = new RealPaypalProvider(
        { clientId: 'id', clientSecret: 'secret', webhookId: 'wh' },
        'test',
      );
      await provider.registerWebhook('https://example.invalid/hook');
      await provider.cancelSubscription({
        subscription: { providerSubId: 'sub_1' } as never,
        atPeriodEnd: false,
      });

      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    });

    it('the Razorpay SDK is constructed with a request timeout', () => {
      const provider = new RealRazorpayProvider({ keyId: 'rzp_test_x', keySecret: 'y' });
      // The SDK takes no timeout option, so the fix reaches for the axios
      // instance it built. If a future version moves this, the assertion is
      // what tells us — see the constructor comment.
      const axiosTimeout = (
        provider as unknown as { client: { api?: { rq?: { defaults?: { timeout?: number } } } } }
      ).client.api?.rq?.defaults?.timeout;
      expect(axiosTimeout).toBe(10_000);
    });

    it('the Stripe SDK is constructed well under its 80s default', () => {
      const provider = new RealStripeProvider({
        apiKey: 'sk_test_for_ci_only',
        webhookSecret: 'whsec_x',
      });
      const stripeClient = (provider as unknown as { stripe: Stripe }).stripe;
      expect(stripeClient.getApiField('timeout')).toBe(10_000);
      expect(stripeClient.getApiField('maxNetworkRetries')).toBe(1);
    });
  });
});
