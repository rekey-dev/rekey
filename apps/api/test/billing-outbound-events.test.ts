/**
 * Outbound BILLING webhook events — the Stripe/PayPal inbound handlers emit
 * `subscription.activated` / `subscription.past_due` / `payment.succeeded` /
 * `payment.failed` (etc.) through the same dispatcher the auth flows use.
 *
 * We register a WebhookEndpoint (wildcard) and assert WebhookDelivery rows
 * appear for the right event types. The endpoint URL is unreachable on
 * purpose — delivery *rows* are what we assert on, not HTTP success.
 *
 * Replay-safety is load-bearing: a provider event that causes no local state
 * change (already-ACTIVE row, duplicate providerPaymentId) must NOT re-emit.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';
import type { WebhookDelivery } from '@prisma/client';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const WEBHOOK_SECRET = 'whsec_test_secret_for_ci_only';

const stripe = new Stripe('sk_for_signing_only', {
  apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
});

function stripeSigned(body: object): { payload: string; headers: Record<string, string> } {
  const payload = JSON.stringify(body);
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, headers: { 'stripe-signature': sig, 'content-type': 'application/json' } };
}

/** Poll for delivery rows of one event type — emission is fire-and-forget. */
async function waitForDeliveries(
  endpointId: string,
  eventType: string,
  count: number,
  timeoutMs = 4000,
): Promise<WebhookDelivery[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: WebhookDelivery[] = [];
  for (;;) {
    rows = await prisma.webhookDelivery.findMany({ where: { endpointId, eventType } });
    if (rows.length >= count || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Settle window for negative assertions ("no NEW delivery appeared"). */
async function settle(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('Outbound billing webhook events', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  interface Bootstrapped {
    applicationId: string;
    endpointId: string;
    planId: string;
    endUserId: string;
  }

  /** Tenant + app (billing on) + plan + end-user + wildcard endpoint. */
  async function bootstrap(slug: string, provider: 'stripe' | 'paypal'): Promise<Bootstrapped> {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: `OBE ${slug}`, ownerEmail: `obe-${slug}@example.com` },
      })
      .then((r) => r.json().data as { id: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: `OBE ${slug}`, slug, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });

    if (provider === 'stripe') {
      await billingCredentialsService.upsertCredentials(
        application.id,
        'stripe',
        { apiKey: 'sk_test_for_ci_only', webhookSecret: WEBHOOK_SECRET },
        { enabled: true, mode: 'test' },
      );
    } else {
      await billingCredentialsService.upsertCredentials(
        application.id,
        'paypal',
        { clientId: 'cid', clientSecret: 'csecret', webhookId: 'WH-TEST' },
        { enabled: true, mode: 'test' },
      );
    }

    const plan = await prisma.plan.create({
      data: {
        applicationId: application.id,
        slug: 'pro_monthly',
        name: 'Pro',
        amount: 999,
        currency: 'USD',
        kind: 'SUBSCRIPTION',
        interval: 'MONTH',
      },
    });
    const endUser = await prisma.endUser.create({
      data: { applicationId: application.id, email: `obe-eu-${slug}@example.com` },
    });
    const { endpoint } = await webhookService.createEndpoint({
      applicationId: application.id,
      url: 'https://example.invalid/billing-hook',
      events: ['*'],
    });
    return {
      applicationId: application.id,
      endpointId: endpoint.id,
      planId: plan.id,
      endUserId: endUser.id,
    };
  }

  // ---------------------------------------------------------------- Stripe

  describe('stripe handler', () => {
    async function fireStripe(slug: string, evt: object): Promise<void> {
      const { payload, headers } = stripeSigned(evt);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/stripe/${slug}`,
        headers,
        payload,
      });
      expect(res.statusCode).toBe(200);
    }

    it('checkout.session.completed emits subscription.activated once — replays do not re-emit', async () => {
      const slug = 'obe-stripe-act';
      const b = await bootstrap(slug, 'stripe');
      const sub = await prisma.subscription.create({
        data: {
          applicationId: b.applicationId,
          endUserId: b.endUserId,
          planId: b.planId,
          status: 'PENDING',
          metadata: { checkoutSessionId: 'cs_obe_act' },
        },
      });

      await fireStripe(slug, {
        id: 'evt_obe_act_1',
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: { id: 'cs_obe_act', subscription: 'sub_obe_act', metadata: { applicationId: b.applicationId } },
        },
      });

      const deliveries = await waitForDeliveries(b.endpointId, 'subscription.activated', 1);
      expect(deliveries).toHaveLength(1);
      const envelope = deliveries[0]!.payload as {
        eventId: string;
        type: string;
        applicationId: string;
        data: { subscription: { id: string; planSlug: string; status: string; endUserId: string; amount: number; currency: string } };
      };
      expect(envelope.type).toBe('subscription.activated');
      expect(envelope.eventId).toBeTruthy(); // consumer-side idempotency key
      expect(envelope.applicationId).toBe(b.applicationId);
      expect(envelope.data.subscription.id).toBe(sub.id);
      expect(envelope.data.subscription.planSlug).toBe('pro_monthly');
      expect(envelope.data.subscription.status).toBe('ACTIVE');
      expect(envelope.data.subscription.endUserId).toBe(b.endUserId);
      expect(envelope.data.subscription.amount).toBe(999);
      expect(envelope.data.subscription.currency).toBe('USD');

      // Exact replay (same provider event id) → deduped at the route, no re-emit.
      await fireStripe(slug, {
        id: 'evt_obe_act_1',
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: { id: 'cs_obe_act', subscription: 'sub_obe_act', metadata: { applicationId: b.applicationId } },
        },
      });
      // A DIFFERENT provider event for the SAME (already-ACTIVE) session must
      // not re-emit either — no state change, no event.
      await fireStripe(slug, {
        id: 'evt_obe_act_2',
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: { id: 'cs_obe_act', subscription: 'sub_obe_act', metadata: { applicationId: b.applicationId } },
        },
      });
      await settle();
      const after = await prisma.webhookDelivery.findMany({
        where: { endpointId: b.endpointId, eventType: 'subscription.activated' },
      });
      expect(after).toHaveLength(1);
    });

    it('invoice.paid emits payment.succeeded once per payment row', async () => {
      const slug = 'obe-stripe-pay';
      const b = await bootstrap(slug, 'stripe');
      const sub = await prisma.subscription.create({
        data: {
          applicationId: b.applicationId,
          endUserId: b.endUserId,
          planId: b.planId,
          status: 'ACTIVE',
          providerSubId: 'sub_obe_pay',
        },
      });

      await fireStripe(slug, {
        id: 'evt_obe_pay_1',
        object: 'event',
        type: 'invoice.paid',
        data: {
          object: {
            id: 'in_obe_pay',
            subscription: 'sub_obe_pay',
            amount_paid: 999,
            currency: 'usd',
            metadata: { applicationId: b.applicationId },
          },
        },
      });

      const deliveries = await waitForDeliveries(b.endpointId, 'payment.succeeded', 1);
      expect(deliveries).toHaveLength(1);
      const envelope = deliveries[0]!.payload as {
        data: { payment: { amount: number; currency: string; status: string; subscriptionId: string; planSlug: string; providerPaymentId: string } };
      };
      expect(envelope.data.payment.amount).toBe(999);
      expect(envelope.data.payment.currency).toBe('USD');
      expect(envelope.data.payment.status).toBe('SUCCEEDED');
      expect(envelope.data.payment.subscriptionId).toBe(sub.id);
      expect(envelope.data.payment.planSlug).toBe('pro_monthly');
      expect(envelope.data.payment.providerPaymentId).toBe('in_obe_pay');
      // Sub was already ACTIVE — no spurious activation event.
      expect(
        await prisma.webhookDelivery.count({
          where: { endpointId: b.endpointId, eventType: 'subscription.activated' },
        }),
      ).toBe(0);

      // Replay with a NEW provider event id but the SAME invoice — the unique
      // providerPaymentId stops the second Payment row, so no re-emit.
      await fireStripe(slug, {
        id: 'evt_obe_pay_2',
        object: 'event',
        type: 'invoice.paid',
        data: {
          object: {
            id: 'in_obe_pay',
            subscription: 'sub_obe_pay',
            amount_paid: 999,
            currency: 'usd',
            metadata: { applicationId: b.applicationId },
          },
        },
      });
      await settle();
      expect(
        await prisma.webhookDelivery.count({
          where: { endpointId: b.endpointId, eventType: 'payment.succeeded' },
        }),
      ).toBe(1);
    });

    it('invoice.payment_failed emits payment.failed + subscription.past_due', async () => {
      const slug = 'obe-stripe-fail';
      const b = await bootstrap(slug, 'stripe');
      const sub = await prisma.subscription.create({
        data: {
          applicationId: b.applicationId,
          endUserId: b.endUserId,
          planId: b.planId,
          status: 'ACTIVE',
          providerSubId: 'sub_obe_fail',
        },
      });

      await fireStripe(slug, {
        id: 'evt_obe_fail_1',
        object: 'event',
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: 'in_obe_fail',
            subscription: 'sub_obe_fail',
            amount_due: 999,
            currency: 'usd',
            metadata: { applicationId: b.applicationId },
          },
        },
      });

      const failed = await waitForDeliveries(b.endpointId, 'payment.failed', 1);
      expect(failed).toHaveLength(1);
      const failedEnvelope = failed[0]!.payload as { data: { payment: { status: string } } };
      expect(failedEnvelope.data.payment.status).toBe('FAILED');

      const pastDue = await waitForDeliveries(b.endpointId, 'subscription.past_due', 1);
      expect(pastDue).toHaveLength(1);
      const pdEnvelope = pastDue[0]!.payload as { data: { subscription: { id: string; status: string } } };
      expect(pdEnvelope.data.subscription.id).toBe(sub.id);
      expect(pdEnvelope.data.subscription.status).toBe('PAST_DUE');
    });

    it('customer.subscription.deleted emits subscription.canceled on the actual transition only', async () => {
      const slug = 'obe-stripe-del';
      const b = await bootstrap(slug, 'stripe');
      await prisma.subscription.create({
        data: {
          applicationId: b.applicationId,
          endUserId: b.endUserId,
          planId: b.planId,
          status: 'ACTIVE',
          providerSubId: 'sub_obe_del',
        },
      });

      const evt = (id: string): object => ({
        id,
        object: 'event',
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_obe_del',
            status: 'canceled',
            canceled_at: Math.floor(Date.now() / 1000),
            metadata: { applicationId: b.applicationId },
          },
        },
      });
      await fireStripe(slug, evt('evt_obe_del_1'));
      const canceled = await waitForDeliveries(b.endpointId, 'subscription.canceled', 1);
      expect(canceled).toHaveLength(1);

      // Re-delete (new provider event id, row already CANCELED) → silent.
      await fireStripe(slug, evt('evt_obe_del_2'));
      await settle();
      expect(
        await prisma.webhookDelivery.count({
          where: { endpointId: b.endpointId, eventType: 'subscription.canceled' },
        }),
      ).toBe(1);
    });
  });

  // ---------------------------------------------------------------- PayPal

  describe('paypal handler', () => {
    function firePaypal(slug: string, eventType: string, resource: Record<string, unknown>, eventId?: string) {
      return app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/paypal/${slug}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ id: eventId ?? `WH-${randomUUID()}`, event_type: eventType, resource }),
      });
    }

    it('BILLING.SUBSCRIPTION.ACTIVATED emits subscription.activated once — replay is silent', async () => {
      const slug = 'obe-pp-act';
      const b = await bootstrap(slug, 'paypal');
      const sub = await prisma.subscription.create({
        data: {
          applicationId: b.applicationId,
          endUserId: b.endUserId,
          planId: b.planId,
          status: 'PENDING',
          provider: 'paypal',
          metadata: { checkoutSessionId: 'I-OBE-ACT' },
        },
      });

      const first = await firePaypal(slug, 'BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-OBE-ACT' });
      expect(first.statusCode).toBe(200);

      const deliveries = await waitForDeliveries(b.endpointId, 'subscription.activated', 1);
      expect(deliveries).toHaveLength(1);
      const envelope = deliveries[0]!.payload as {
        applicationId: string;
        data: { subscription: { id: string; planSlug: string; status: string; provider: string | null } };
      };
      expect(envelope.applicationId).toBe(b.applicationId);
      expect(envelope.data.subscription.id).toBe(sub.id);
      expect(envelope.data.subscription.planSlug).toBe('pro_monthly');
      expect(envelope.data.subscription.status).toBe('ACTIVE');

      // New provider event id, already-ACTIVE row → no state change, no event.
      await firePaypal(slug, 'BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-OBE-ACT' });
      await settle();
      expect(
        await prisma.webhookDelivery.count({
          where: { endpointId: b.endpointId, eventType: 'subscription.activated' },
        }),
      ).toBe(1);
    });

    it('PAYMENT.SALE.COMPLETED emits payment.succeeded once per sale id', async () => {
      const slug = 'obe-pp-pay';
      const b = await bootstrap(slug, 'paypal');
      const sub = await prisma.subscription.create({
        data: {
          applicationId: b.applicationId,
          endUserId: b.endUserId,
          planId: b.planId,
          status: 'ACTIVE',
          provider: 'paypal',
          providerSubId: 'I-OBE-PAY',
        },
      });

      await firePaypal(slug, 'PAYMENT.SALE.COMPLETED', {
        id: 'SALE-OBE-1',
        billing_agreement_id: 'I-OBE-PAY',
        amount: { total: '9.99', currency: 'USD' },
      });

      const deliveries = await waitForDeliveries(b.endpointId, 'payment.succeeded', 1);
      expect(deliveries).toHaveLength(1);
      const envelope = deliveries[0]!.payload as {
        data: { payment: { amount: number; currency: string; subscriptionId: string; planSlug: string } };
      };
      expect(envelope.data.payment.amount).toBe(999);
      expect(envelope.data.payment.currency).toBe('USD');
      expect(envelope.data.payment.subscriptionId).toBe(sub.id);
      expect(envelope.data.payment.planSlug).toBe('pro_monthly');

      // Same sale id again (new provider event id) → duplicate Payment row is
      // refused → no re-emit.
      await firePaypal(slug, 'PAYMENT.SALE.COMPLETED', {
        id: 'SALE-OBE-1',
        billing_agreement_id: 'I-OBE-PAY',
        amount: { total: '9.99', currency: 'USD' },
      });
      await settle();
      expect(
        await prisma.webhookDelivery.count({
          where: { endpointId: b.endpointId, eventType: 'payment.succeeded' },
        }),
      ).toBe(1);
    });

    it('PAYMENT.SALE.DENIED emits payment.failed + subscription.past_due', async () => {
      const slug = 'obe-pp-fail';
      const b = await bootstrap(slug, 'paypal');
      const sub = await prisma.subscription.create({
        data: {
          applicationId: b.applicationId,
          endUserId: b.endUserId,
          planId: b.planId,
          status: 'ACTIVE',
          provider: 'paypal',
          providerSubId: 'I-OBE-FAIL',
        },
      });

      await firePaypal(slug, 'PAYMENT.SALE.DENIED', {
        id: 'SALE-OBE-DENIED',
        billing_agreement_id: 'I-OBE-FAIL',
        amount: { total: '9.99', currency: 'USD' },
      });

      const failed = await waitForDeliveries(b.endpointId, 'payment.failed', 1);
      expect(failed).toHaveLength(1);

      const pastDue = await waitForDeliveries(b.endpointId, 'subscription.past_due', 1);
      expect(pastDue).toHaveLength(1);
      const envelope = pastDue[0]!.payload as { data: { subscription: { id: string; status: string } } };
      expect(envelope.data.subscription.id).toBe(sub.id);
      expect(envelope.data.subscription.status).toBe('PAST_DUE');
    });
  });

  // ------------------------------------------------- entitlements on payload

  /**
   * `data.subscription.entitlements` — what the subscription actually grants.
   *
   * The plan slug cannot answer that: `entitlementOverrides` is how a bespoke
   * quantity is sold without minting a private plan, so two subscribers on one
   * plan can hold different amounts. A consumer that provisions off the slug
   * therefore provisions the wrong thing for exactly the customers who paid for
   * something different, and it has no user token with which to go and ask.
   */
  describe('resolved entitlements on the payload', () => {
    interface WithEntitlements {
      data: {
        subscription: {
          entitlements: Array<{ kind: string; key: string; valueType: string | null; value: string | null }>;
        };
      };
    }

    async function activate(
      slug: string,
      opts: { entitlementOverrides?: Record<string, unknown> } = {},
    ): Promise<WithEntitlements> {
      const b = await bootstrap(slug, 'stripe');
      await prisma.planEntitlement.create({
        data: { planId: b.planId, kind: 'FEATURE', key: 'max_widgets', valueType: 'INT', value: '2' },
      });
      await prisma.subscription.create({
        data: {
          applicationId: b.applicationId,
          endUserId: b.endUserId,
          planId: b.planId,
          status: 'PENDING',
          metadata: { checkoutSessionId: `cs_${slug}` },
          ...(opts.entitlementOverrides !== undefined && {
            entitlementOverrides: opts.entitlementOverrides,
          }),
        },
      });

      const { payload, headers } = stripeSigned({
        id: `evt_${slug}`,
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_${slug}`,
            subscription: `sub_${slug}`,
            metadata: { applicationId: b.applicationId },
          },
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/stripe/${slug}`,
        headers,
        payload,
      });
      expect(res.statusCode).toBe(200);

      const deliveries = await waitForDeliveries(b.endpointId, 'subscription.activated', 1);
      expect(deliveries).toHaveLength(1);
      return deliveries[0]!.payload as unknown as WithEntitlements;
    }

    it("carries the plan's entitlement rows", async () => {
      const envelope = await activate('obe-ent-plan');
      expect(envelope.data.subscription.entitlements).toContainEqual(
        expect.objectContaining({ kind: 'FEATURE', key: 'max_widgets', valueType: 'INT', value: '2' }),
      );
    });

    it("applies the subscription's overrides, not the plan's raw value", async () => {
      // The whole reason the slug is not enough. A consumer reading this
      // payload must see 5, which is what this customer bought.
      const envelope = await activate('obe-ent-override', {
        entitlementOverrides: { 'FEATURE:max_widgets': 5 },
      });
      expect(envelope.data.subscription.entitlements).toContainEqual(
        expect.objectContaining({ key: 'max_widgets', value: '5' }),
      );
    });
  });
});
