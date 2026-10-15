/**
 * Money in the super-admin metrics, `/api/v1/admin/metrics/*`.
 *
 * Every figure is reported per currency and never added across currencies,
 * and a subscription counts at its own price rather than its plan's default.
 * The assertions read the HTTP response, so a field the response schema
 * drops fails here even when the service computed it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { pricedAt } from './subscription-price-fixture.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { seedPlan } from './seed-plan.js';

operatorsConfirmTheirEmail();

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const BASE = '/api/v1/admin/metrics';
const DAY_MS = 24 * 60 * 60 * 1000;

interface MrrEntry {
  currency: string;
  mrrCents: number;
  activeSubscriptions: number;
}

interface Window {
  count: number;
  volumeCents: number;
}

interface Overview {
  mrrByCurrency: MrrEntry[];
  subscriptions: { active: number };
  payments: {
    lifetime: { count: number };
    last30d: { count: number };
    byCurrency: Array<{ currency: string; lifetime: Window; last30d: Window }>;
    succeededLast24h: number;
    failedLast24h: number;
  };
}

interface TenantRow {
  id: string;
  activeSubscriptions: number;
  mrrByCurrency: MrrEntry[];
}

interface PaymentsByAppRow {
  applicationId: string;
  volumeByCurrency: Array<{ currency: string; volumeCents: number; payments: number }>;
}

interface SubscriptionRow {
  id: string;
  currency: string | null;
  amount: number | null;
  interval: string;
}

describe('admin metrics: money per currency', () => {
  let app: FastifyInstance;
  let serial = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function get<T>(path: string): Promise<T> {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/${path}`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as T;
  }

  async function createTenant(name: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name, ownerEmail: `${name.toLowerCase()}-${++serial}@example.com` },
    });
    expect(r.statusCode, r.body).toBe(201);
    return (r.json().data as { id: string }).id;
  }

  async function createApplication(tenantId: string, slug: string, currency: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { tenantId, name: slug, slug },
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json().data as { id: string }).id;
    await prisma.application.update({ where: { id }, data: { billingConfig: { reportingCurrency: currency } } });
    return id;
  }

  async function plan(
    applicationId: string,
    slug: string,
    amount: number,
    currency: string,
    interval: 'MONTH' | 'YEAR' = 'MONTH',
  ): Promise<string> {
    const row = await seedPlan({ applicationId, slug, name: slug, interval, kind: 'SUBSCRIPTION' }, amount > 0 ? { currency: currency, amount: amount } : null);
    return row.id;
  }

  async function subscribe(
    applicationId: string,
    planId: string,
    own: { currency?: string; unitAmount?: number; status?: 'ACTIVE' | 'CANCELED' } = {},
  ): Promise<string> {
    const endUser = await prisma.endUser.create({
      data: { applicationId, email: `buyer-${++serial}@example.com` },
    });
    const row = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId,
        status: own.status ?? 'ACTIVE',
        ...(own.currency === undefined || own.unitAmount === undefined
          ? {}
          : await pricedAt(planId, own.currency, own.unitAmount)),
      },
    });
    return row.id;
  }

  async function pay(
    applicationId: string,
    amount: number,
    currency: string,
    extra: { status?: 'SUCCEEDED' | 'PARTIALLY_REFUNDED' | 'FAILED'; refundedAmount?: number; daysAgo?: number } = {},
  ): Promise<void> {
    await prisma.payment.create({
      data: {
        applicationId,
        amount,
        currency,
        status: extra.status ?? 'SUCCEEDED',
        refundedAmount: extra.refundedAmount ?? 0,
        createdAt: new Date(Date.now() - (extra.daysAgo ?? 0) * DAY_MS - 60_000),
      },
    });
  }

  /**
   * One tenant, two applications, dollars and rupees.
   *
   * `usdApp` bills in USD and holds: one subscription to the USD 1,000 plan
   * with no price of its own, one yearly USD subscription at its own 12,000
   * (the plan says 24,000), two INR subscriptions at 49,900 and one buyer on
   * the USD plan who pays their own 39,900 in `inr`.
   *
   * `inrApp` bills in INR and holds only payments: two in USD, one in INR.
   */
  async function seedMixed(): Promise<{ tenantId: string; usdApp: string; inrApp: string; ownPriced: string; planPriced: string }> {
    const tenantId = await createTenant('Mixed');
    const usdApp = await createApplication(tenantId, `mixed-usd-${++serial}`, 'USD');
    const inrApp = await createApplication(tenantId, `mixed-inr-${++serial}`, 'INR');

    const usdMonthly = await plan(usdApp, 'usd_m', 1000, 'USD');
    const usdYearly = await plan(usdApp, 'usd_y', 24000, 'USD', 'YEAR');
    const inrMonthly = await plan(usdApp, 'inr_m', 49900, 'INR');

    const planPriced = await subscribe(usdApp, usdMonthly);
    await subscribe(usdApp, usdYearly, { currency: 'USD', unitAmount: 12000 });
    await subscribe(usdApp, inrMonthly, { currency: 'INR', unitAmount: 49900 });
    await subscribe(usdApp, inrMonthly, { currency: 'INR', unitAmount: 49900 });
    const ownPriced = await subscribe(usdApp, usdMonthly, { currency: 'inr', unitAmount: 39900 });
    await subscribe(usdApp, inrMonthly, { status: 'CANCELED' });

    await pay(usdApp, 1500, 'USD');
    await pay(usdApp, 2500, 'USD', { status: 'PARTIALLY_REFUNDED', refundedAmount: 500, daysAgo: 3 });
    await pay(usdApp, 1000, 'usd', { daysAgo: 5 });
    await pay(usdApp, 700, 'USD', { daysAgo: 60 });
    await pay(usdApp, 80000, 'INR', { daysAgo: 2 });
    await pay(usdApp, 99999, 'INR', { status: 'FAILED' });
    await pay(usdApp, 5000, 'JPY', { status: 'FAILED' });

    await pay(inrApp, 300, 'USD', { daysAgo: 1 });
    await pay(inrApp, 400, 'USD', { daysAgo: 1 });
    await pay(inrApp, 70000, 'inr', { daysAgo: 1 });

    return { tenantId, usdApp, inrApp, ownPriced, planPriced };
  }

  it('overview reports MRR per currency, each subscription at its own price', async () => {
    await seedMixed();
    const data = await get<Overview>('overview');

    // INR: 49,900 + 49,900 + the buyer's own 39,900. USD: 12,000 / 12, and
    // nothing for the subscription with no price of its own.
    expect(data.mrrByCurrency).toEqual([
      { currency: 'INR', mrrCents: 139700, activeSubscriptions: 3 },
      { currency: 'USD', mrrCents: 1000, activeSubscriptions: 1 },
    ]);
    for (const removed of ['mrrCents', 'mrrCurrency', 'mixedCurrencies', 'mrrCapped']) {
      expect(data).not.toHaveProperty(removed);
    }
    expect(data.subscriptions.active).toBe(5);
  });

  it('overview reports payment volume per currency and merges lower-case codes', async () => {
    await seedMixed();
    const { payments } = await get<Overview>('overview');

    // USD leads on the number of payments, though the rupee figures are larger numbers.
    expect(payments.byCurrency).toEqual([
      { currency: 'USD', lifetime: { count: 6, volumeCents: 5900 }, last30d: { count: 5, volumeCents: 5200 } },
      { currency: 'INR', lifetime: { count: 2, volumeCents: 150000 }, last30d: { count: 2, volumeCents: 150000 } },
    ]);
    // Counts cover every currency; no volume sits beside them.
    expect(payments.lifetime).toEqual({ count: 8 });
    expect(payments.last30d).toEqual({ count: 7 });
    expect(payments).not.toHaveProperty('currency');
    expect(payments).not.toHaveProperty('mixedCurrencies');
    expect(payments.succeededLast24h).toBe(1);
    expect(payments.failedLast24h).toBe(2);
  });

  it('a tenant row lists its MRR per currency, its reporting currency first', async () => {
    const { tenantId } = await seedMixed();
    const page = await get<{ items: TenantRow[] }>('tenants?sort=mrr');
    const row = page.items.find((t) => t.id === tenantId)!;

    // The tenant's application reports in USD and has USD subscriptions, so
    // USD is first although more of its subscriptions are in rupees.
    for (const removed of ['mrrCents', 'mrrCurrency', 'mixedCurrencies', 'mrrCapped']) {
      expect(row).not.toHaveProperty(removed);
    }
    expect(row.mrrByCurrency).toEqual([
      { currency: 'USD', mrrCents: 1000, activeSubscriptions: 1 },
      { currency: 'INR', mrrCents: 139700, activeSubscriptions: 3 },
    ]);
    expect(row.activeSubscriptions).toBe(5);
  });

  it('payments-by-app lists volume per currency, the application currency first', async () => {
    const { usdApp, inrApp } = await seedMixed();
    const rows = await get<PaymentsByAppRow[]>('payments-by-app');

    const usd = rows.find((r) => r.applicationId === usdApp)!;
    for (const removed of ['volumeCents', 'volumeCurrency', 'mixedCurrencies']) {
      expect(usd).not.toHaveProperty(removed);
    }
    expect(usd.volumeByCurrency).toEqual([
      { currency: 'USD', volumeCents: 4500, payments: 3 },
      { currency: 'INR', volumeCents: 80000, payments: 1 },
    ]);

    // Configured for INR and paid in INR once: INR leads its own list, though
    // USD has more payments.
    const inr = rows.find((r) => r.applicationId === inrApp)!;
    expect(inr.volumeByCurrency).toEqual([
      { currency: 'INR', volumeCents: 70000, payments: 1 },
      { currency: 'USD', volumeCents: 700, payments: 2 },
    ]);
  });

  it('a subscription row shows its own price, and no price when it has none', async () => {
    const { ownPriced, planPriced } = await seedMixed();
    const page = await get<{ items: SubscriptionRow[] }>('subscriptions?limit=50');

    expect(page.items.find((s) => s.id === ownPriced)).toMatchObject({ currency: 'INR', amount: 39900 });
    // Its plan costs USD 10.00, which is not reported as what this subscription pays.
    expect(page.items.find((s) => s.id === planPriced)).toMatchObject({ currency: null, amount: null });
  });
});
