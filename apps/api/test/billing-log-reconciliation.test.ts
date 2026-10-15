/**
 * Reconciliation: the billing log compared with payments, refunds and
 * subscriptions. Each finding kind, what is deliberately not a finding, and
 * that the comparison never changes a money row.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ReconciliationReportSchema, type ReconciliationReport } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import {
  reconcileApplication,
  reconcileRecentActivity,
  reconciliationPeriod,
  recordBillingEvent,
  recordReconciliationFindings,
  type BillingEventInput,
} from '../src/modules/billing-log/index.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';
import { countQueries } from './query-counter.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { seedPlan } from './seed-plan.js';

operatorsConfirmTheirEmail();

const MINUTE_MS = 60 * 1000;
const ago = (minutes: number): Date => new Date(Date.now() - minutes * MINUTE_MS);

describe('billing log reconciliation', () => {
  let app: FastifyInstance;
  let world: OperatorWorld;
  let serial = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const payment = (applicationId: string, over: Record<string, unknown> = {}) =>
    prisma.payment.create({
      data: { applicationId, amount: 1900, currency: 'USD', status: 'SUCCEEDED', createdAt: ago(30), ...over },
    });

  const recorded = (applicationId: string, paymentId: string, over: Partial<BillingEventInput> = {}): BillingEventInput =>
    ({
      type: 'payment.recorded',
      applicationId,
      actor: { type: 'provider', id: 'stripe' },
      paymentId,
      currency: 'USD',
      amount: 1900,
      occurredAt: ago(30),
      data: { priceCharged: null, discountAmount: 0, providerPaymentId: null, verification: 'verified' },
      ...over,
    }) as BillingEventInput;

  const refunded = (applicationId: string, paymentId: string, amount: number, currency = 'USD'): BillingEventInput =>
    ({
      type: 'payment.refunded',
      applicationId,
      actor: { type: 'operator', id: 'op_1' },
      paymentId,
      refundId: `re_${++serial}`,
      currency,
      amount,
      occurredAt: ago(20),
      data: { refundedAmount: amount, totalRefunded: amount, providerRefundId: null, initiatedBy: 'operator', reasonCode: null },
    }) as BillingEventInput;

  /** The log's first payment event, an hour old: every check starts there. */
  async function startLog(applicationId: string): Promise<void> {
    const first = await payment(applicationId, { createdAt: ago(60) });
    await recordBillingEvent(prisma, recorded(applicationId, first.id, { occurredAt: ago(60) }));
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL rekey.billing_events_maintenance = 'on'`);
      await tx.$executeRaw`UPDATE "billing_events" SET "recorded_at" = ${ago(60)} WHERE "application_id" = ${applicationId}`;
    });
  }

  async function subscription(applicationId: string, over: Record<string, unknown> = {}) {
    const n = ++serial;
    const plan = await seedPlan({ applicationId, slug: `plan-${n}`, name: `Plan ${n}`, interval: 'MONTH', kind: 'SUBSCRIPTION' }, { currency: 'USD', amount: 1900 });
    const endUser = await prisma.endUser.create({ data: { applicationId, email: `buyer-${n}@example.com` } });
    return prisma.subscription.create({
      data: { applicationId, endUserId: endUser.id, planId: plan.id, status: 'ACTIVE', createdAt: ago(30), ...over },
    });
  }

  const report = (applicationId: string): Promise<ReconciliationReport> =>
    reconcileApplication(applicationId, reconciliationPeriod({}));

  it('reports nothing when every payment, refund and subscription is in the log', async () => {
    world = await operatorWorld(app);
    const id = world.appId;
    await startLog(id);
    const paid = await payment(id, { refundedAmount: 500, status: 'PARTIALLY_REFUNDED' });
    await recordBillingEvent(prisma, recorded(id, paid.id));
    await prisma.refund.create({ data: { applicationId: id, paymentId: paid.id, amount: 500, currency: 'USD', status: 'SUCCEEDED', initiatedBy: 'OPERATOR' } });
    await recordBillingEvent(prisma, refunded(id, paid.id, 500));
    const sub = await subscription(id);
    await recordBillingEvent(prisma, {
      type: 'subscription.activated',
      applicationId: id,
      actor: { type: 'provider' },
      subscriptionId: sub.id,
      data: { planSlug: 'pro', price: null, via: 'checkout', trial: false },
    });

    const clean = await report(id);
    expect(clean.findings).toEqual([]);
    expect(clean.counts).toEqual({ payment_without_event: 0, event_without_payment: 0, refund_mismatch: 0, subscription_without_event: 0 });
    expect(clean.checked).toMatchObject({ payments: 2, refunds: 1, subscriptions: 1 });
    expect(clean.truncated).toBe(false);
  });

  it('finds a payment with no event, and leaves out a pending one and one older than the log', async () => {
    world = await operatorWorld(app);
    const id = world.appId;
    await startLog(id);
    const missing = await payment(id, { currency: 'INR', amount: 149900 });
    const failed = await payment(id, { status: 'FAILED' });
    await payment(id, { status: 'PENDING' });
    await payment(id, { createdAt: ago(90) });
    const logged = await payment(id);
    await recordBillingEvent(prisma, recorded(id, logged.id));

    const found = await report(id);
    expect(found.counts.payment_without_event).toBe(2);
    expect(found.findings.map((f) => [f.kind, f.paymentId, f.currency, f.amount]).sort()).toEqual(
      [
        ['payment_without_event', missing.id, 'INR', 149900],
        ['payment_without_event', failed.id, 'USD', 1900],
      ].sort(),
    );
    expect(found.paymentsLoggedSince).not.toBeNull();
  });

  it("finds an event naming a payment that does not exist, including one that is another Application's", async () => {
    world = await operatorWorld(app);
    const other = await operatorWorld(app);
    const id = world.appId;
    await startLog(id);
    const theirs = await payment(other.appId);
    await recordBillingEvent(prisma, recorded(id, 'pay_ghost'));
    await recordBillingEvent(prisma, recorded(id, theirs.id));

    const found = await report(id);
    expect(found.counts.event_without_payment).toBe(2);
    expect(found.findings.map((f) => f.paymentId).sort()).toEqual(['pay_ghost', theirs.id].sort());
    expect(found.findings.every((f) => f.kind === 'event_without_payment' && f.eventSeq !== null)).toBe(true);
    // The other Application's own report is not touched by any of it.
    expect((await report(other.appId)).findings).toEqual([]);
  });

  it('finds refunds that add up differently on the payment, in the refund rows and in the log', async () => {
    world = await operatorWorld(app);
    const id = world.appId;
    await startLog(id);
    const refund = (paymentId: string, amount: number, over: Record<string, unknown> = {}) =>
      prisma.refund.create({ data: { applicationId: id, paymentId, amount, currency: 'USD', status: 'SUCCEEDED', initiatedBy: 'OPERATOR', ...over } });

    // The log is short of one refund.
    const unlogged = await payment(id, { refundedAmount: 800, status: 'PARTIALLY_REFUNDED' });
    await recordBillingEvent(prisma, recorded(id, unlogged.id));
    await refund(unlogged.id, 500);
    await refund(unlogged.id, 300);
    await recordBillingEvent(prisma, refunded(id, unlogged.id, 500));

    // The payment's own total is behind its refund rows.
    const stale = await payment(id, { refundedAmount: 0 });
    await recordBillingEvent(prisma, recorded(id, stale.id));
    await refund(stale.id, 400);
    await recordBillingEvent(prisma, refunded(id, stale.id, 400));

    // A pending refund and a failed one are not money returned.
    const agreed = await payment(id, { refundedAmount: 200, status: 'PARTIALLY_REFUNDED' });
    await recordBillingEvent(prisma, recorded(id, agreed.id));
    await refund(agreed.id, 200);
    await refund(agreed.id, 900, { status: 'PENDING' });
    await refund(agreed.id, 900, { status: 'FAILED' });
    await recordBillingEvent(prisma, refunded(id, agreed.id, 200));

    // A refund event in another currency is never added to the payment's total.
    const crossed = await payment(id, { refundedAmount: 100, status: 'PARTIALLY_REFUNDED' });
    await recordBillingEvent(prisma, recorded(id, crossed.id));
    await refund(crossed.id, 100);
    await recordBillingEvent(prisma, refunded(id, crossed.id, 100, 'INR'));

    const found = await report(id);
    const mismatches = found.findings.filter((f) => f.kind === 'refund_mismatch');
    expect(mismatches.map((f) => [f.paymentId, f.refundedOnPayment, f.refundRowsTotal, f.refundEventsTotal]).sort()).toEqual(
      [
        [unlogged.id, 800, 800, 500],
        [stale.id, 0, 400, 400],
        [crossed.id, 100, 100, 0],
      ].sort(),
    );
    expect(found.counts.refund_mismatch).toBe(3);
  });

  it('finds a live subscription with no activation event, and leaves out a pending one', async () => {
    world = await operatorWorld(app);
    const id = world.appId;
    const logged = await subscription(id, { createdAt: ago(60) });
    await recordBillingEvent(prisma, {
      type: 'subscription.granted',
      applicationId: id,
      actor: { type: 'operator', id: 'op_1' },
      subscriptionId: logged.id,
      occurredAt: ago(60),
      data: { planSlug: 'pro', price: null },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL rekey.billing_events_maintenance = 'on'`);
      await tx.$executeRaw`UPDATE "billing_events" SET "recorded_at" = ${ago(60)} WHERE "application_id" = ${id}`;
    });
    const missing = await subscription(id);
    await subscription(id, { status: 'PENDING' });

    const found = await report(id);
    expect(found.findings.map((f) => [f.kind, f.subscriptionId])).toEqual([['subscription_without_event', missing.id]]);
  });

  it('writes each finding to the log once and never changes a payment, a refund or a subscription', async () => {
    world = await operatorWorld(app);
    const id = world.appId;
    await startLog(id);
    const missing = await payment(id);
    const mismatched = await payment(id, { refundedAmount: 300, status: 'PARTIALLY_REFUNDED' });
    await recordBillingEvent(prisma, recorded(id, mismatched.id));
    await prisma.refund.create({ data: { applicationId: id, paymentId: mismatched.id, amount: 300, currency: 'USD', status: 'SUCCEEDED', initiatedBy: 'PROVIDER' } });
    await subscription(id);

    const money = async () => ({
      payments: await prisma.payment.findMany({ where: { applicationId: id }, orderBy: { id: 'asc' } }),
      refunds: await prisma.refund.findMany({ where: { applicationId: id }, orderBy: { id: 'asc' } }),
      subscriptions: await prisma.subscription.findMany({ where: { applicationId: id }, orderBy: { id: 'asc' } }),
    });
    const before = await money();

    const found = await report(id);
    expect(await recordReconciliationFindings(found)).toBe(2);
    expect(await recordReconciliationFindings(await report(id))).toBe(0);
    expect(await money()).toEqual(before);

    const events = await prisma.billingEvent.findMany({ where: { applicationId: id, type: 'reconciliation.finding' }, orderBy: { seq: 'asc' } });
    expect(events.map((e) => [e.tier, e.paymentId, (e.data as { kind: string }).kind]).sort()).toEqual(
      [
        ['DIAGNOSTIC', missing.id, 'payment_without_event'],
        ['DIAGNOSTIC', mismatched.id, 'refund_mismatch'],
      ].sort(),
    );
    expect(events.find((e) => e.paymentId === mismatched.id)!.data).toMatchObject({
      refundedOnPayment: 300,
      refundRowsTotal: 300,
      refundEventsTotal: 0,
    });

    // The scheduled run reaches the same Application and finds nothing new.
    const swept = await reconcileRecentActivity(undefined, new Date(Date.now() + 11 * MINUTE_MS));
    expect(swept.applications).toBeGreaterThanOrEqual(1);
    expect(swept.findings).toBe(0);
  });

  describe('the operator report', () => {
    const get = (w: OperatorWorld, query = '') =>
      w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/billing/reconciliation${query}`, headers: bearer(w.ownerToken) });

    it('returns the report in its declared shape, in a number of queries that does not grow with the rows', async () => {
      world = await operatorWorld(app);
      const id = world.appId;
      await startLog(id);
      await payment(id);
      const small = await countQueries(() => get(world));

      await prisma.payment.createMany({
        data: Array.from({ length: 300 }, () => ({ applicationId: id, amount: 500, currency: 'USD', status: 'SUCCEEDED' as const, createdAt: ago(10) })),
      });
      let res = await get(world);
      const large = await countQueries(async () => {
        res = await get(world);
      });
      expect(res.statusCode, res.body).toBe(200);
      const data = ReconciliationReportSchema.parse(res.json().data);
      expect(data.checked.payments).toBe(302);
      expect(data.counts.payment_without_event).toBe(200);
      expect(data.truncated).toBe(true);
      expect(large.count, large.queries.join('\n')).toBe(small.count);
    });
  });
});
