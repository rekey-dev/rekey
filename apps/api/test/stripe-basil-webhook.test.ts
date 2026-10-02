/**
 * Stripe webhooks in both API shapes, through the real pipeline.
 *
 * Endpoints an older Rekey registered deliver `2024-11-20.acacia` until the
 * operator re-registers them; new ones deliver `STRIPE_API_VERSION`. A renewal
 * paid and then refunded in the Stripe dashboard has to land on the same
 * Payment row in either shape. In the basil-or-later shape the refunded charge
 * no longer names its invoice, so the pipeline must hand the translator the
 * credentials that verified the event, and a failed lookup must leave the
 * event retryable rather than record the refund against nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../src/modules/billing/providers/stripe-api-version.js';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';

const lookup = vi.hoisted(() => ({ keys: [] as string[], list: vi.fn() }));

vi.mock('../src/modules/billing/providers/stripe-client.js', () => ({
  createStripeClient: (apiKey: string) => {
    lookup.keys.push(apiKey);
    return { invoicePayments: { list: lookup.list } };
  },
}));

const STRIPE_SECRET = 'whsec_basil_pipeline';
const TEST_KEY = 'sk_test_basil_pipeline';
const signer = new Stripe('sk_for_signing_only', { apiVersion: STRIPE_API_VERSION });

describe('Stripe webhooks across the acacia and basil-or-later shapes', () => {
  let app: FastifyInstance;
  let appId: string;
  let appSlug: string;
  let token: string;
  let seq = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    lookup.keys.length = 0;
    lookup.list.mockReset();
    const tag = Math.random().toString(36).slice(2, 8);
    const su = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `basil-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${tag}` },
    });
    if (su.statusCode !== 201) throw new Error(`signup ${su.statusCode}: ${su.body}`);
    token = (su.json().data as { accessToken: string }).accessToken;
    appSlug = `basil-${tag}`;
    const ac = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: appSlug, slug: appSlug },
    });
    if (ac.statusCode !== 201) throw new Error(`appcreate ${ac.statusCode}: ${ac.body}`);
    appId = (ac.json().data as { id: string }).id;
    await billingCredentialsService.upsertCredentials(
      appId,
      'stripe',
      { apiKey: TEST_KEY, webhookSecret: STRIPE_SECRET },
      { enabled: true, mode: 'test' },
    );
  });

  function post(body: Record<string, unknown>) {
    const payload = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/billing/stripe/${appSlug}`,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signer.webhooks.generateTestHeaderString({ payload, secret: STRIPE_SECRET }),
      },
      payload,
    });
  }

  function event(type: string, object: Record<string, unknown>): Record<string, unknown> {
    seq += 1;
    return { id: `evt_basil_${seq}`, type, livemode: false, data: { object } };
  }

  /** A renewal invoice whose only applicationId is the subscription snapshot. */
  function basilInvoicePaid(id: string, amount: number) {
    return event('invoice.paid', {
      id,
      object: 'invoice',
      amount_paid: amount,
      currency: 'usd',
      billing_reason: 'subscription_cycle',
      metadata: {},
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_basil_unknown', metadata: { applicationId: appId } },
      },
    });
  }

  function acaciaInvoicePaid(id: string, amount: number) {
    return event('invoice.paid', {
      id,
      object: 'invoice',
      amount_paid: amount,
      currency: 'usd',
      billing_reason: 'subscription_cycle',
      subscription: 'sub_acacia_unknown',
      metadata: {},
      subscription_details: { metadata: { applicationId: appId } },
    });
  }

  function basilChargeRefunded(intent: string, amountRefunded: number) {
    return event('charge.refunded', {
      id: `ch_${intent}`,
      object: 'charge',
      amount: 2000,
      amount_refunded: amountRefunded,
      currency: 'usd',
      payment_intent: intent,
      metadata: {},
    });
  }

  const paymentOf = (providerPaymentId: string) =>
    prisma.payment.findFirstOrThrow({ where: { applicationId: appId, providerPaymentId } });
  const receiptOf = (eventId: unknown) =>
    prisma.webhookEvent.findFirstOrThrow({ where: { applicationId: appId, providerEventId: String(eventId) } });

  it('basil: routes the renewal by its subscription snapshot and puts the refund on that invoice', async () => {
    const paid = await post(basilInvoicePaid('in_basil_r', 2000));
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ processed: true });
    expect((await paymentOf('in_basil_r')).status).toBe('SUCCEEDED');

    lookup.list.mockResolvedValue({ data: [{ invoice: 'in_basil_r', status: 'paid' }] });
    const refunded = await post(basilChargeRefunded('pi_basil_r', 700));
    expect(refunded.statusCode).toBe(200);
    expect(refunded.json()).toMatchObject({ processed: true });

    const payment = await paymentOf('in_basil_r');
    expect(payment.status).toBe('PARTIALLY_REFUNDED');
    expect(payment.refundedAmount).toBe(700);
    // The lookup was made with this Application's own key, the one whose mode
    // the event was checked against.
    expect(lookup.keys).toEqual([TEST_KEY]);
    expect(lookup.list).toHaveBeenCalledWith({
      payment: { type: 'payment_intent', payment_intent: 'pi_basil_r' },
      limit: 10,
    });
  });

  it('basil: a failed lookup answers 500, applies nothing, and the retry applies', async () => {
    await post(basilInvoicePaid('in_basil_retry', 2000));
    const body = basilChargeRefunded('pi_basil_retry', 2000);

    lookup.list.mockRejectedValueOnce(new Error('connection reset'));
    const failed = await post(body);
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ processed: false });
    expect((await paymentOf('in_basil_retry')).refundedAmount).toBe(0);
    const receipt = await receiptOf(body.id);
    expect(receipt.processedAt).toBeNull();
    expect(receipt.processingError).toContain('connection reset');

    lookup.list.mockResolvedValueOnce({ data: [{ invoice: 'in_basil_retry' }] });
    const retried = await post(body);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ processed: true });
    const payment = await paymentOf('in_basil_retry');
    expect(payment.status).toBe('REFUNDED');
    expect(payment.refundedAmount).toBe(2000);
  });

  it('an invoice whose snapshot names another Application is refused 400 and records nothing', async () => {
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `${appSlug}-b`, slug: `${appSlug}-b` },
    });
    expect(other.statusCode).toBe(201);
    const otherId = (other.json().data as { id: string }).id;

    for (const body of [basilInvoicePaid('in_foreign_basil', 2000), acaciaInvoicePaid('in_foreign_acacia', 2000)]) {
      const object = (body.data as { object: Record<string, unknown> }).object;
      const parent = object.parent as { subscription_details: { metadata: Record<string, string> } } | undefined;
      if (parent) parent.subscription_details.metadata = { applicationId: otherId };
      else object.subscription_details = { metadata: { applicationId: otherId } };

      const res = await post(body);
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('WEBHOOK_APPLICATION_MISMATCH');
      expect((await receiptOf(body.id)).processingError).toContain('WEBHOOK_APPLICATION_MISMATCH');
    }
    expect(
      await prisma.payment.count({
        where: { providerPaymentId: { in: ['in_foreign_basil', 'in_foreign_acacia'] } },
      }),
    ).toBe(0);
  });

  it('acacia: the same renewal and refund apply with no Stripe call', async () => {
    const paid = await post(acaciaInvoicePaid('in_acacia_r', 2000));
    expect(paid.statusCode).toBe(200);
    expect((await paymentOf('in_acacia_r')).status).toBe('SUCCEEDED');

    const refunded = await post(
      event('charge.refunded', {
        id: 'ch_acacia_r',
        object: 'charge',
        amount: 2000,
        amount_refunded: 500,
        currency: 'usd',
        invoice: 'in_acacia_r',
        payment_intent: 'pi_acacia_r',
        metadata: {},
      }),
    );
    expect(refunded.statusCode).toBe(200);
    expect((await paymentOf('in_acacia_r')).refundedAmount).toBe(500);
    expect(lookup.list).not.toHaveBeenCalled();
  });
});
