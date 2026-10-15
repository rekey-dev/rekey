/**
 * Unverified payments and the money totals.
 *
 * A charge Rekey recorded and did not apply is not revenue. It is reported on
 * its own, per currency, until an operator applies it to a subscription.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { recordBillingEvent, type BillingEventInput } from '../src/modules/billing-log/index.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { seedPlan } from './seed-plan.js';

operatorsConfirmTheirEmail();

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface Stats {
  revenueLast30d: Array<{ currency: string; grossCents: number; refundedCents: number; netCents: number; payments: number }>;
  unverified: Array<{ currency: string; amountCents: number; payments: number }>;
  monthlyRevenue: Array<{ currency: string; months: Array<{ month: string; amountCents: number }> }>;
  paymentsLast30d: { succeeded: number; failed: number };
}

describe('unverified payments stay out of revenue', () => {
  let app: FastifyInstance;
  let w: OperatorWorld;
  let unverifiedInr: { id: string };

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    w = await operatorWorld(app, 'APP_ADMIN');
    await prisma.payment.create({ data: { applicationId: w.appId, amount: 1900, currency: 'USD', status: 'SUCCEEDED' } });
    // Two charges nothing matched, one of them partly refunded, and one that failed.
    await prisma.payment.create({
      data: { applicationId: w.appId, amount: 700, currency: 'USD', status: 'SUCCEEDED', verification: 'UNVERIFIED' },
    });
    unverifiedInr = await prisma.payment.create({
      data: { applicationId: w.appId, amount: 149900, currency: 'INR', status: 'PARTIALLY_REFUNDED', refundedAmount: 9900, verification: 'UNVERIFIED' },
    });
    await prisma.payment.create({
      data: { applicationId: w.appId, amount: 5000, currency: 'EUR', status: 'FAILED', verification: 'UNVERIFIED' },
    });
    await prisma.payment.create({
      data: { applicationId: w.appId, amount: 300, currency: 'EUR', status: 'REFUNDED', refundedAmount: 300, verification: 'UNVERIFIED' },
    });
  });

  const stats = async (): Promise<Stats> => {
    const res = await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/billing/stats`, headers: bearer(w.ownerToken) });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as Stats;
  };

  it('billing stats: revenue is the verified payment, the rest is listed as unverified per currency', async () => {
    const s = await stats();
    expect(s.revenueLast30d).toEqual([{ currency: 'USD', grossCents: 1900, refundedCents: 0, netCents: 1900, payments: 1 }]);
    expect(s.monthlyRevenue.map((m) => m.currency)).toEqual(['USD']);
    expect(s.monthlyRevenue[0]!.months.at(-1)!.amountCents).toBe(1900);
    expect(s.unverified).toEqual([
      { currency: 'USD', amountCents: 700, payments: 1 },
      { currency: 'INR', amountCents: 140000, payments: 1 },
    ]);
  });

  it('super-admin overview and payments-by-app: volume is verified, unverified money is its own list', async () => {
    const overview = await w.inject({ method: 'GET', url: '/api/v1/admin/metrics/overview', headers: bearer(ADMIN_KEY) });
    expect(overview.statusCode, overview.body).toBe(200);
    const payments = (overview.json().data as {
      payments: {
        lifetime: { count: number };
        byCurrency: Array<{ currency: string; lifetime: { count: number; volumeCents: number }; last30d: { count: number; volumeCents: number } }>;
        unverified: Array<{ currency: string; amountCents: number; payments: number }>;
      };
    }).payments;
    expect(payments.byCurrency).toEqual([
      { currency: 'USD', lifetime: { count: 1, volumeCents: 1900 }, last30d: { count: 1, volumeCents: 1900 } },
    ]);
    expect(payments.lifetime.count).toBe(1);
    expect(payments.unverified).toEqual([
      { currency: 'INR', amountCents: 140000, payments: 1 },
      { currency: 'USD', amountCents: 700, payments: 1 },
    ]);

    const adminRows = await w.inject({
      method: 'GET',
      url: `/api/v1/admin/metrics/payments?applicationId=${w.appId}`,
      headers: bearer(ADMIN_KEY),
    });
    expect(adminRows.statusCode, adminRows.body).toBe(200);
    const admin = (adminRows.json().data as { items: Array<{ status: string; verification: string; refundedAmount: number; currency: string }> }).items;
    expect(admin.every((p) => typeof p.refundedAmount === 'number' && ['verified', 'unverified'].includes(p.verification))).toBe(true);
    expect(admin.map((p) => p.verification).sort()).toContain('unverified');
    expect(admin.find((p) => p.status === 'PARTIALLY_REFUNDED')).toMatchObject({ refundedAmount: expect.any(Number) });
    const partly = await w.inject({
      method: 'GET',
      url: `/api/v1/admin/metrics/payments?applicationId=${w.appId}&status=PARTIALLY_REFUNDED`,
      headers: bearer(ADMIN_KEY),
    });
    expect(partly.statusCode, partly.body).toBe(200);
    expect((partly.json().data as { items: Array<{ status: string }> }).items.map((p) => p.status)).toEqual(['PARTIALLY_REFUNDED']);
    const tenantRows = await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/payments`, headers: bearer(w.ownerToken) });
    const tenant = (tenantRows.json().data as { items: Array<{ verification: string }> }).items;
    expect(tenant.map((p) => p.verification).sort()).toEqual(admin.map((p) => p.verification).sort());

    const byApp = await w.inject({ method: 'GET', url: '/api/v1/admin/metrics/payments-by-app', headers: bearer(ADMIN_KEY) });
    expect(byApp.statusCode, byApp.body).toBe(200);
    const row = (byApp.json().data as Array<{ applicationId: string; volumeByCurrency: unknown }>).find((r) => r.applicationId === w.appId)!;
    expect(row.volumeByCurrency).toEqual([{ currency: 'USD', volumeCents: 1900, payments: 1 }]);
  });

  it('applying an unapplied case to a subscription verifies its payment, which then counts as revenue', async () => {
    const plan = await seedPlan({ applicationId: w.appId, slug: 'pro', name: 'Pro', interval: 'MONTH' }, { currency: 'USD', amount: 1900 });
    const endUser = await prisma.endUser.create({ data: { applicationId: w.appId, email: 'payer@example.com' } });
    const sub = await prisma.subscription.create({ data: { applicationId: w.appId, endUserId: endUser.id, planId: plan.id, status: 'ACTIVE' } });
    const kase = await prisma.unappliedPayment.create({
      data: { applicationId: w.appId, paymentId: unverifiedInr.id, provider: 'razorpay', amount: 149900, currency: 'INR', endUserId: endUser.id },
    });

    const res = await w.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.appId}/unapplied-payments/${kase.id}/extend`,
      headers: bearer(w.ownerToken),
      payload: { days: 30 },
    });
    expect(res.statusCode, res.body).toBe(200);

    const list = await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/payments`, headers: bearer(w.ownerToken) });
    const applied = (list.json().data as { items: Array<{ id: string; subscriptionId: string | null }> }).items.find((p) => p.id === unverifiedInr.id)!;
    expect(applied.subscriptionId).toBe(sub.id);
    expect(applied).toMatchObject({ verification: 'verified', refundedAmount: 9900 });

    const s = await stats();
    expect(s.revenueLast30d).toEqual([
      { currency: 'USD', grossCents: 1900, refundedCents: 0, netCents: 1900, payments: 1 },
      { currency: 'INR', grossCents: 149900, refundedCents: 9900, netCents: 140000, payments: 1 },
    ]);
    expect(s.unverified).toEqual([{ currency: 'USD', amountCents: 700, payments: 1 }]);
  });

  it('reconciliation finds nothing wrong with an unverified payment that has no subscription', async () => {
    const ago = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);
    await prisma.payment.deleteMany({ where: { applicationId: w.appId } });
    const charge = await prisma.payment.create({
      data: { applicationId: w.appId, amount: 700, currency: 'USD', status: 'SUCCEEDED', verification: 'UNVERIFIED', createdAt: ago(30) },
    });
    const base = { applicationId: w.appId, actor: { type: 'provider', id: 'stripe' }, paymentId: charge.id, currency: 'USD', amount: 700, occurredAt: ago(30) };
    await recordBillingEvent(prisma, {
      ...base,
      type: 'payment.recorded',
      data: { priceCharged: null, discountAmount: 0, providerPaymentId: null, verification: 'unverified' },
    } as BillingEventInput);
    await recordBillingEvent(prisma, {
      ...base,
      type: 'payment.not_applied',
      data: { reason: 'no_subscription', expected: null, providerPaymentId: null },
    } as BillingEventInput);

    const res = await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/billing/reconciliation`, headers: bearer(w.ownerToken) });
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json().data as { checked: { payments: number }; findings: unknown[] };
    expect(report.checked.payments).toBe(1);
    expect(report.findings).toEqual([]);
  });
});
