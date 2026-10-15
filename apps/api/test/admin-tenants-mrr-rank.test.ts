/**
 * `GET /admin/metrics/tenants?sort=mrr` orders every tenant by MRR in one
 * currency, in the database, before the page is cut.
 *
 * Two bugs this holds shut. A rupee figure is a larger number than the same
 * money in dollars, so comparing raw amounts across currencies put every INR
 * tenant on top. And the sort used to run over one page of the newest
 * tenants, so the largest tenant was missing from the first page whenever it
 * was not also among the newest.
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

interface TenantRow {
  id: string;
  name: string;
  mrrByCurrency: Array<{ currency: string; mrrCents: number; activeSubscriptions: number }>;
}
interface TenantPage {
  items: TenantRow[];
  page: { total: number };
  sortedByMrrIn: string | null;
}

describe('admin tenants ranked by MRR', () => {
  let app: FastifyInstance;
  let serial = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const admin = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    app.inject({
      method,
      url: `/api/v1/admin/${url}`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      ...(payload !== undefined && { payload }),
    });

  /**
   * A tenant with one application and `subscribers` ACTIVE subscriptions to
   * one monthly plan per entry, each at the plan's price unless `unpriced`.
   */
  async function tenant(
    name: string,
    ...mrr: Array<{ currency: string; amount: number; subscribers: number; unpriced?: boolean }>
  ): Promise<void> {
    const created = await admin('POST', 'tenants', { name, ownerEmail: `owner-${++serial}@example.com` });
    expect(created.statusCode, created.body).toBe(201);
    const tenantId = (created.json().data as { id: string }).id;
    const application = await admin('POST', 'applications', { tenantId, name, slug: `rank-${serial}` });
    expect(application.statusCode, application.body).toBe(201);
    const applicationId = (application.json().data as { id: string }).id;
    for (const entry of mrr) {
      const plan = await seedPlan({ applicationId, slug: `pro-${++serial}`, name: 'Pro', interval: 'MONTH', kind: 'SUBSCRIPTION' }, entry.amount > 0 ? { currency: entry.currency, amount: entry.amount } : null);
      for (let i = 0; i < entry.subscribers; i += 1) {
        const endUser = await prisma.endUser.create({ data: { applicationId, email: `buyer-${++serial}@example.com` } });
        const price = entry.unpriced === true ? {} : await pricedAt(plan.id, entry.currency, entry.amount);
        await prisma.subscription.create({ data: { applicationId, endUserId: endUser.id, planId: plan.id, status: 'ACTIVE', ...price } });
      }
    }
  }

  async function page(query: string): Promise<TenantPage> {
    const res = await admin('GET', `metrics/tenants?${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as TenantPage;
  }
  const names = async (query: string): Promise<string[]> => (await page(query)).items.map((t) => t.name);

  it('ranks in the headline currency only, and a rupee total never outranks a dollar one', async () => {
    // USD has the most active subscriptions on the platform, so it is the headline.
    await tenant('Small', { currency: 'USD', amount: 1000, subscribers: 2 });
    await tenant('Large', { currency: 'USD', amount: 9000, subscribers: 1 });
    await tenant('Rupee', { currency: 'INR', amount: 500000, subscribers: 1 });
    // 300 in dollars beside a much larger rupee figure: ranked on the dollars alone.
    await tenant('Both', { currency: 'USD', amount: 300, subscribers: 1 }, { currency: 'INR', amount: 900000, subscribers: 1 });
    await tenant('Empty');
    // On the dearest plan of all with no price of its own: worth nothing in the ranking.
    await tenant('Unpriced', { currency: 'USD', amount: 990000, subscribers: 1, unpriced: true });

    const ranked = await page('sort=mrr');
    expect(ranked.sortedByMrrIn).toBe('USD');
    expect(ranked.items.slice(0, 3).map((t) => t.name)).toEqual(['Large', 'Small', 'Both']);
    // Nothing in dollars: both sort as zero, after every dollar tenant.
    expect(new Set(ranked.items.slice(3).map((t) => t.name))).toEqual(new Set(['Rupee', 'Empty', 'Unpriced']));
    expect(ranked.items.find((t) => t.name === 'Unpriced')!.mrrByCurrency.filter((e) => e.mrrCents > 0)).toEqual([]);
    expect(ranked.items.find((t) => t.name === 'Both')!.mrrByCurrency.map((e) => [e.currency, e.mrrCents]).sort()).toEqual([
      ['INR', 900000],
      ['USD', 300],
    ]);

    expect((await names('sort=mrr&order=asc')).slice(-3)).toEqual(['Both', 'Small', 'Large']);

    // A named currency ranks in that one instead.
    const rupees = await page('sort=mrr&currency=inr');
    expect(rupees.sortedByMrrIn).toBe('INR');
    expect(rupees.items.slice(0, 2).map((t) => t.name)).toEqual(['Both', 'Rupee']);
    expect((await page('sort=name')).sortedByMrrIn).toBeNull();
  });

  it('sorts the whole set before cutting the page: the largest tenant is first even when it is the oldest', async () => {
    // Created first, so every other tenant is newer than the largest one.
    await tenant('Whale', { currency: 'USD', amount: 99000, subscribers: 1 });
    for (let i = 0; i < 9; i += 1) await tenant(`Minnow${i}`, { currency: 'USD', amount: 100 + i, subscribers: 1 });

    const first = await page('sort=mrr&limit=3');
    expect(first.page.total).toBe(10);
    expect(first.items.map((t) => t.name)).toEqual(['Whale', 'Minnow8', 'Minnow7']);

    // Paging by offset walks the same total order: every tenant once, none twice.
    const walked: string[] = [];
    for (let offset = 0; offset < 10; offset += 3) walked.push(...(await names(`sort=mrr&limit=3&offset=${offset}`)));
    expect(walked).toEqual(['Whale', ...Array.from({ length: 9 }, (_, i) => `Minnow${8 - i}`)]);
  });

  it('breaks ties on the id, so tenants with equal MRR page without repeats or gaps', async () => {
    for (let i = 0; i < 7; i += 1) await tenant(`Tie${i}`, { currency: 'USD', amount: 500, subscribers: 1 });
    const walked: string[] = [];
    for (let offset = 0; offset < 7; offset += 2) walked.push(...(await page(`sort=mrr&limit=2&offset=${offset}`)).items.map((t) => t.id));
    expect(walked).toHaveLength(7);
    expect(new Set(walked).size).toBe(7);
    // And the same walk twice gives the same order.
    const again: string[] = [];
    for (let offset = 0; offset < 7; offset += 2) again.push(...(await page(`sort=mrr&limit=2&offset=${offset}`)).items.map((t) => t.id));
    expect(again).toEqual(walked);
  });

  it('searches and sorts together, and treats search wildcards as text', async () => {
    await tenant('Acme One', { currency: 'USD', amount: 100, subscribers: 1 });
    await tenant('Acme Two', { currency: 'USD', amount: 900, subscribers: 1 });
    await tenant('Other', { currency: 'USD', amount: 5000, subscribers: 1 });
    expect(await names('sort=mrr&q=acme')).toEqual(['Acme Two', 'Acme One']);
    expect(await names('sort=mrr&q=%25')).toEqual([]);
    expect((await admin('GET', 'metrics/tenants?sort=mrrCents')).statusCode).toBe(400);
    expect((await admin('GET', 'metrics/tenants?sort=mrr&currency=dollars')).statusCode).toBe(400);
  });
});
