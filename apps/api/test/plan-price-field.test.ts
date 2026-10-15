/**
 * A plan states its default price as `price`, over REST as over MCP: the
 * plan-level `amount`, `currency` and `pricePerUnitCents` are refused on the
 * way in and absent on the way out. Asserted on the wire.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const REMOVED = ['amount', 'currency', 'pricePerUnitCents'] as const;
const REMOVED_VALUES: Record<(typeof REMOVED)[number], unknown> = { amount: 1900, currency: 'USD', pricePerUnitCents: 5 };

interface WirePlan extends Record<string, unknown> {
  slug: string;
  isFree: boolean;
  defaultPriceId: string | null;
  price: { currency: string; amount: number } | null;
  prices: Array<{ id: string; currency: string; amount: number; isDefault: boolean }>;
}

describe('the plan price field', () => {
  let app: FastifyInstance;
  let w: OperatorWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await operatorWorld(app, 'APP_ADMIN');
  });

  const surfaces = {
    tenant: (method: string, path: string, payload?: unknown) =>
      w.inject({ method, url: `/api/v1/tenant/applications/${w.appId}${path}`, headers: bearer(w.ownerToken), ...(payload !== undefined && { payload }) }),
    admin: (method: string, path: string, payload?: unknown) =>
      w.inject({ method, url: `/api/v1/admin/applications/${w.appId}${path}`, headers: bearer(ADMIN_KEY), ...(payload !== undefined && { payload }) }),
  };
  const planCount = () => prisma.plan.count({ where: { applicationId: w.appId } });

  describe.each(['tenant', 'admin'] as const)('on the %s routes', (surface) => {
    const call = (method: string, path: string, payload?: unknown) => surfaces[surface](method, path, payload);

    it('creates a plan from `price` and returns it with no amount, currency or per-unit price of its own', async () => {
      const res = await call('POST', '/plans', { slug: 'pro', name: 'Pro', price: { currency: 'usd', amount: 1900 } });
      expect(res.statusCode, res.body).toBe(201);
      const plan = res.json().data as WirePlan;
      expect(plan).toMatchObject({
        slug: 'pro',
        isFree: false,
        price: { currency: 'USD', amount: 1900, isDefault: true },
        prices: [{ currency: 'USD', amount: 1900, isDefault: true }],
      });
      expect(plan.defaultPriceId).toBe(plan.prices[0]!.id);
      for (const field of REMOVED) expect(plan, field).not.toHaveProperty(field);

      const listed = await call('GET', '/plans');
      const [onList] = (listed.json().data as { items: WirePlan[] }).items;
      expect(onList).toMatchObject({ slug: 'pro', price: { currency: 'USD', amount: 1900 } });
      for (const field of REMOVED) expect(onList, field).not.toHaveProperty(field);
    });

    it.each(REMOVED)('refuses `%s` on create with a fix that names what to send, and creates nothing', async (field) => {
      const res = await call('POST', '/plans', { slug: 'old', name: 'Old', [field]: REMOVED_VALUES[field] });
      expect(res.statusCode, res.body).toBe(400);
      const error = res.json().error as { code: string; message: string; fix: string };
      expect(error.code).toBe('BILLING_FIELD_REMOVED');
      expect(error.message).toContain(`\`${field}\``);
      expect(error.fix).toContain(field === 'pricePerUnitCents' ? '`meterSlug`' : '`price`: { "currency": "USD", "amount": 1900 }');
      expect(await planCount()).toBe(0);
    });

    it('changes the default price with `price`, and makes the plan free with `price: null`, as the update fix says', async () => {
      await call('POST', '/plans', { slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 1900 } });

      const repriced = await call('PATCH', '/plans/pro', { price: { currency: 'EUR', amount: 1700 } });
      expect(repriced.statusCode, repriced.body).toBe(200);
      expect(repriced.json().data).toMatchObject({ isFree: false, price: { currency: 'EUR', amount: 1700 }, prices: [{ currency: 'EUR', amount: 1700, isDefault: true }] });

      const freed = await call('PATCH', '/plans/pro', { price: null });
      expect(freed.statusCode, freed.body).toBe(200);
      expect(freed.json().data).toMatchObject({ isFree: true, price: null, prices: [], defaultPriceId: null });
    });

  });

  it('creates a USAGE plan from its meter alone: not free, and with no flat price', async () => {
    const meter = await surfaces.tenant('POST', '/usage-meters', { slug: 'calls', name: 'Calls', unit: 'call' });
    expect(meter.statusCode, meter.body).toBe(201);
    const res = await surfaces.tenant('POST', '/plans', { slug: 'metered', name: 'Metered', kind: 'USAGE', meterSlug: 'calls' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data).toMatchObject({ kind: 'USAGE', meterSlug: 'calls', isFree: false, price: null, prices: [] });

    const withBaseFee = await surfaces.tenant('POST', '/plans', {
      slug: 'metered-base',
      name: 'Metered with a base fee',
      kind: 'USAGE',
      meterSlug: 'calls',
      price: { currency: 'USD', amount: 500 },
    });
    expect(withBaseFee.statusCode, withBaseFee.body).toBe(201);
    expect(withBaseFee.json().data).toMatchObject({ isFree: false, price: { currency: 'USD', amount: 500 } });
  });

  it("leaves the plan's price out of the plan summary on an end-user's subscriptions and on their export", async () => {
    await surfaces.tenant('POST', '/plans', { slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 1900 } });
    const signUp = await w.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: bearer(w.secretKey),
      payload: { email: `buyer-${Math.random().toString(36).slice(2, 9)}@example.com`, password: 'pw-one-two-three' },
    });
    expect(signUp.statusCode, signUp.body).toBe(201);
    const endUserId = (signUp.json().data as { endUser: { id: string } }).endUser.id;
    const granted = await surfaces.tenant('POST', `/end-users/${endUserId}/subscriptions`, { planSlug: 'pro' });
    expect(granted.statusCode, granted.body).toBe(201);

    for (const path of [`/end-users/${endUserId}/billing`, `/end-users/${endUserId}/export`]) {
      const res = await surfaces.tenant('GET', path);
      expect(res.statusCode, res.body).toBe(200);
      // The export is the document itself, with no `data` envelope.
      const body = res.json() as { data?: unknown };
      const [subscription] = ((body.data ?? body) as { subscriptions: Array<{ plan: Record<string, unknown>; price: unknown }> }).subscriptions;
      expect(subscription!.plan, path).toEqual({ slug: 'pro', name: 'Pro', kind: 'SUBSCRIPTION', interval: 'MONTH' });
      expect(subscription!.price, path).toEqual({ amount: 1900, currency: 'USD' });
    }
  });
});
