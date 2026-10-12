/**
 * A provider report that leaves no payment or refund row still reaches the
 * operator: a refund for a payment Rekey never recorded, and an amount no row
 * can hold, are each written to the billing log as `payment.not_recorded`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BillingLogEntrySchema } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';

describe('provider reports that cannot be recorded', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await twoCurrencyWorld(app);
  });

  async function notRecorded() {
    const res = await w.operator('GET', '/billing/events?type=payment.not_recorded');
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data as { items: unknown[] }).items.map((entry) => {
      const parsed = BillingLogEntrySchema.parse(entry);
      if (parsed.type !== 'payment.not_recorded') throw new Error(`unexpected ${parsed.type}`);
      return parsed;
    });
  }

  it('a refund for a payment that was never recorded is acknowledged and logged', async () => {
    const refund = { payment: { id: 'pay_never_seen', subscriptionId: 'sub_never_seen', amount: 500, currency: 'usd', refundId: 'rf_1' } };
    const first = await w.externalEvent('payment.refunded', refund);
    expect(first.res.statusCode, first.res.body).toBe(200);

    const [entry, ...rest] = await notRecorded();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      tier: 'PERMANENT',
      actor: { type: 'provider', id: 'external' },
      provider: 'external',
      providerEventId: first.eventId,
      paymentId: null,
      currency: 'USD',
      amount: 500,
      data: { kind: 'refund', reason: 'payment_unknown', providerPaymentId: 'pay_never_seen', providerRefundId: 'rf_1', reportedAmount: '500' },
    });
    expect(await prisma.refund.count({ where: { applicationId: w.applicationId } })).toBe(0);
  });

  it('a charge whose amount no payment row can hold is logged with the amount as reported, and no payment is written', async () => {
    const sent = await w.externalEvent('payment.succeeded', {
      payment: { id: 'pay_huge', subscriptionId: 'sub_any', amount: 3_000_000_000, currency: 'usd' },
    });
    expect(sent.res.statusCode, sent.res.body).toBe(200);

    const entries = await notRecorded();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      providerEventId: sent.eventId,
      paymentId: null,
      currency: 'USD',
      amount: null,
      data: { kind: 'charge', reason: 'amount_not_storable', providerPaymentId: 'pay_huge', providerRefundId: null, reportedAmount: '3000000000' },
    });
    expect(await prisma.payment.count({ where: { applicationId: w.applicationId } })).toBe(0);
  });

  it('a failed charge and a refund with such an amount are logged too', async () => {
    await prisma.subscription.create({
      data: { applicationId: w.applicationId, endUserId: w.buyer.id, planId: w.planId, status: 'ACTIVE', provider: 'external', providerSubId: 'sub_live' },
    });
    const failed = await w.externalEvent('payment.failed', {
      payment: { id: 'pay_failed_huge', subscriptionId: 'sub_live', amount: 4_000_000_000, currency: 'usd' },
    });
    expect(failed.res.statusCode, failed.res.body).toBe(200);
    const refunded = await w.externalEvent('payment.refunded', {
      payment: { id: 'pay_refund_huge', subscriptionId: 'sub_any', amount: 5_000_000_000, currency: 'usd' },
    });
    expect(refunded.res.statusCode, refunded.res.body).toBe(200);

    const seen = (await notRecorded()).map((entry) => ({ ...entry.data }));
    expect(seen).toEqual(
      expect.arrayContaining([
        { kind: 'failed_charge', reason: 'amount_not_storable', providerPaymentId: 'pay_failed_huge', providerRefundId: null, reportedAmount: '4000000000' },
        { kind: 'refund', reason: 'amount_not_storable', providerPaymentId: 'pay_refund_huge', providerRefundId: null, reportedAmount: '5000000000' },
      ]),
    );
    expect(seen).toHaveLength(2);
    expect((await prisma.subscription.findFirstOrThrow({ where: { providerSubId: 'sub_live' } })).status).toBe('ACTIVE');
  });

  it('a refund larger than its payment is refused and logged against that payment', async () => {
    const payment = await prisma.payment.create({
      data: { applicationId: w.applicationId, amount: 1000, currency: 'USD', status: 'SUCCEEDED', provider: 'external', providerPaymentId: 'pay_small' },
    });
    const sent = await w.externalEvent('payment.refunded', {
      payment: { id: 'pay_small', subscriptionId: 'sub_any', amount: 5000, currency: 'usd', refundId: 'rf_over' },
    });
    expect(sent.res.statusCode, sent.res.body).toBe(200);
    const entries = await notRecorded();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ paymentId: payment.id, amount: 5000, data: { kind: 'refund', reason: 'exceeds_payment', providerRefundId: 'rf_over' } });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).refundedAmount).toBe(0);
  });
});
