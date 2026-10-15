/**
 * Reading one payment as an operator: the single payment route, the
 * `refundable` judgement it shares with the refund route, and what the
 * payments list costs.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { REFUND_BLOCKED_REASONS, TenantPaymentDtoSchema, type RefundBlockedReason } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import type { RefundPaymentInput, RefundPaymentResult } from '../src/modules/billing/providers/types.js';
import { fakeStripe } from './fakes/billing-providers.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';
import { countQueries } from './query-counter.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { seedPlan } from './seed-plan.js';

operatorsConfirmTheirEmail();

type Refunding = { refundPayment?: (input: RefundPaymentInput) => Promise<RefundPaymentResult> };

describe('reading one payment as an operator', () => {
  let app: FastifyInstance;
  let serial = 0;
  let asked: RefundPaymentInput[] = [];

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    delete (fakeStripe as Refunding).refundPayment;
  });

  /** A workspace whose Application takes payments through Stripe, which refunds whatever it is asked to. */
  async function stripeWorld(): Promise<OperatorWorld> {
    const w = await operatorWorld(app);
    await billingCredentialsService.upsertRaw(
      w.appId,
      'stripe',
      { apiKey: 'sk_test_ci_only', webhookSecret: 'whsec_ci_only' },
      { mode: 'test', enabled: true, currencies: ['USD'], priority: 1 },
    );
    asked = [];
    (fakeStripe as Refunding).refundPayment = async (input) => {
      asked.push(input);
      return { refundId: `re_${asked.length}`, amount: input.amount ?? 0, currency: 'USD', status: 'succeeded' };
    };
    return w;
  }

  async function endUser(w: OperatorWorld): Promise<{ id: string; email: string }> {
    serial += 1;
    const email = `payer-${serial}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const row = await prisma.endUser.create({ data: { applicationId: w.appId, email, passwordHash: 'x' } });
    return { id: row.id, email };
  }

  async function payment(w: OperatorWorld, over: Partial<Prisma.PaymentUncheckedCreateInput> = {}): Promise<string> {
    serial += 1;
    const row = await prisma.payment.create({
      data: {
        applicationId: w.appId,
        amount: 1900,
        currency: 'USD',
        status: 'SUCCEEDED',
        provider: 'stripe',
        providerPaymentId: `in_${serial}`,
        ...over,
      },
    });
    return row.id;
  }

  const get = (w: OperatorWorld, path: string, token = w.ownerToken) =>
    w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}${path}`, headers: bearer(token) });
  const refund = (w: OperatorWorld, paymentId: string, body: Record<string, unknown> = {}) =>
    w.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.appId}/payments/${paymentId}/refunds`,
      headers: bearer(w.ownerToken),
      payload: body,
    });

  it('returns the payment with every field of the list row, its provider and whether it can be refunded', async () => {
    const w = await stripeWorld();
    const payer = await endUser(w);
    const id = await payment(w, { endUserId: payer.id, description: 'Pro, monthly', verification: 'UNVERIFIED' });

    const res = await get(w, `/payments/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json().data as Record<string, unknown>;
    expect(TenantPaymentDtoSchema.strict().parse(body)).toEqual({
      id,
      endUserId: payer.id,
      endUserEmail: payer.email,
      subscriptionId: null,
      amount: 1900,
      currency: 'USD',
      status: 'SUCCEEDED',
      refundedAmount: 0,
      verification: 'unverified',
      provider: 'stripe',
      refundable: true,
      refundBlockedReason: null,
      providerPaymentId: expect.stringMatching(/^in_/) as string,
      description: 'Pro, monthly',
      createdAt: expect.any(String) as string,
    });

    const listed = await get(w, '/payments');
    expect((listed.json().data as { items: unknown[] }).items).toEqual([body]);
  });

  it('follows a refund: partly refunded is still refundable, fully refunded is not', async () => {
    const w = await stripeWorld();
    const id = await payment(w);
    expect((await refund(w, id, { amount: 500 })).statusCode).toBe(200);
    expect((await get(w, `/payments/${id}`)).json().data).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      refundedAmount: 500,
      refundable: true,
      refundBlockedReason: null,
    });
    expect((await refund(w, id)).statusCode).toBe(200);
    expect((await get(w, `/payments/${id}`)).json().data).toMatchObject({
      status: 'REFUNDED',
      refundedAmount: 1900,
      refundable: false,
      refundBlockedReason: 'already_refunded',
    });
  });

  const BLOCKED: Array<[RefundBlockedReason, Partial<Prisma.PaymentUncheckedCreateInput>, string | null, string]> = [
    ['payment_not_succeeded', { status: 'PENDING' }, 'stripe', 'BILLING_PAYMENT_NOT_REFUNDABLE'],
    ['no_provider_charge_id', { providerPaymentId: null }, 'stripe', 'BILLING_PAYMENT_NOT_REFUNDABLE'],
    ['already_refunded', { status: 'REFUNDED', refundedAmount: 1900 }, 'stripe', 'BILLING_PAYMENT_ALREADY_REFUNDED'],
    // Marked refunded before the amount was recorded.
    ['already_refunded', { status: 'REFUNDED', refundedAmount: 0 }, 'stripe', 'BILLING_PAYMENT_ALREADY_REFUNDED'],
    ['provider_unknown', { provider: null }, null, 'BILLING_PAYMENT_NOT_REFUNDABLE'],
    ['provider_cannot_refund', { provider: 'external' }, 'external', 'BILLING_REFUND_UNSUPPORTED'],
    ['provider_not_configured', { provider: 'paypal' }, 'paypal', 'BILLING_CREDENTIALS_NOT_CONFIGURED'],
  ];

  it.each(BLOCKED)(
    'says %s where the refund route refuses, and the provider is never asked (%o)',
    async (reason, over, provider, refusal) => {
      const w = await stripeWorld();
      const id = await payment(w, over);

      const read = (await get(w, `/payments/${id}`)).json().data as Record<string, unknown>;
      expect(read).toMatchObject({ provider, refundable: false, refundBlockedReason: reason });
      const [row] = ((await get(w, '/payments')).json().data as { items: Array<Record<string, unknown>> }).items;
      expect(row).toEqual(read);

      const refused = await refund(w, id);
      expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
      expect(refused.json().error.code).toBe(refusal);
      expect(asked).toHaveLength(0);
    },
  );

  it('covers every reason the union names', () => {
    expect(new Set(BLOCKED.map(([reason]) => reason))).toEqual(new Set(REFUND_BLOCKED_REASONS));
  });

  it('reads the provider off the subscription or the unapplied case when the payment names none', async () => {
    const w = await stripeWorld();
    const payer = await endUser(w);
    const plan = await seedPlan({ applicationId: w.appId, slug: 'pro', name: 'Pro' }, { currency: 'USD', amount: 1900 });
    const subscription = await prisma.subscription.create({
      data: { applicationId: w.appId, endUserId: payer.id, planId: plan.id, status: 'ACTIVE', provider: 'stripe' },
    });
    const viaSubscription = await payment(w, { provider: null, subscriptionId: subscription.id });
    expect((await get(w, `/payments/${viaSubscription}`)).json().data).toMatchObject({
      provider: 'stripe',
      subscriptionId: subscription.id,
      refundable: true,
    });
    expect((await refund(w, viaSubscription)).statusCode).toBe(200);
    expect(asked).toHaveLength(1);

    const viaCase = await payment(w, { provider: null });
    await prisma.unappliedPayment.create({
      data: { applicationId: w.appId, paymentId: viaCase, provider: 'paypal', amount: 1900, currency: 'USD' },
    });
    expect((await get(w, `/payments/${viaCase}`)).json().data).toMatchObject({
      provider: 'paypal',
      refundable: false,
      refundBlockedReason: 'provider_not_configured',
    });
  });

  it('answers 404 for an unknown id and for a payment of another Application, and 403 without billing:read', async () => {
    const mine = await stripeWorld();
    const theirs = await stripeWorld();
    const foreign = await payment(theirs);

    for (const id of ['pay_missing', foreign]) {
      const res = await get(mine, `/payments/${id}`);
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error.code).toBe('PAYMENT_NOT_FOUND');
      expect(res.body).not.toContain('in_');
    }
    const otherWorkspace = await mine.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${theirs.appId}/payments/${foreign}`,
      headers: bearer(mine.ownerToken),
    });
    expect(otherWorkspace.statusCode).toBe(404);
    expect(otherWorkspace.json().error.code).toBe('APPLICATION_NOT_FOUND');

    const own = await payment(mine);
    expect((await get(mine, `/payments/${own}`, mine.memberToken)).statusCode).toBe(200);
    await mine.setScopes(['overview:read']);
    const unscoped = await get(mine, `/payments/${own}`, mine.memberToken);
    expect(unscoped.statusCode, unscoped.body).toBe(403);
    expect(unscoped.json().error.code).toBe('SCOPE_INSUFFICIENT');
    const keyed = await get(mine, `/payments/${own}`, mine.secretKey);
    expect(keyed.statusCode).toBe(401);
  });

  it('lists a page of payments in the same number of queries for one payment as for many', async () => {
    const one = await stripeWorld();
    const many = await stripeWorld();
    const payers = await Promise.all(Array.from({ length: 6 }, () => endUser(many)));
    await payment(one, { endUserId: (await endUser(one)).id });
    for (const [index, payer] of payers.entries()) {
      await payment(many, { endUserId: payer.id, provider: index % 2 === 0 ? 'stripe' : 'paypal' });
    }

    const small = await countQueries(() => get(one, '/payments'));
    const large = await countQueries(() => get(many, '/payments'));
    const rows = ((await get(many, '/payments')).json().data as { items: Array<{ refundable: boolean; endUserEmail: string | null }> }).items;
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.refundable)).toHaveLength(3);
    expect(rows.every((row) => row.endUserEmail !== null)).toBe(true);
    expect(large.count, large.queries.join('\n')).toBe(small.count);
  });
});
