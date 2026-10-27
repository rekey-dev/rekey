/**
 * The billing tools of one Application, each against a stub that records the
 * request: method, path, query, body and the credential it carried.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AdminClient } from '../src/client.js';
import { tools } from '../src/tools.js';
import { zodToJsonSchema } from '../src/lib/zod-to-json-schema.js';

interface Recorded {
  key: string;
  body: unknown;
  auth: string | undefined;
}

const ADMIN_KEY = 'x'.repeat(40);
const OPERATOR_TOKEN = 'rp_op_test-token';
const APP = '/api/v1/tenant/applications/app_1';
const UNITS = 'integer, minor units of the currency (cents for USD, whole yen for JPY)';

const READ_TOOLS = [
  'recent_billing_events',
  'preview_checkout_routing',
  'get_price_fallbacks',
  'get_billing_reconciliation',
  'get_payment',
  'list_refunds',
  'get_reporting_currency',
  'get_billing_stats',
];
const WRITE_TOOLS = ['set_plan_price', 'archive_plan_price', 'create_coupon', 'update_coupon', 'set_reporting_currency'];

/** Arguments that pass each tool's schema, for the tests that only need the call to be made. */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  recent_billing_events: { applicationId: 'app_1' },
  preview_checkout_routing: { applicationId: 'app_1', country: 'IN' },
  get_price_fallbacks: { applicationId: 'app_1' },
  get_billing_reconciliation: { applicationId: 'app_1' },
  get_payment: { applicationId: 'app_1', paymentId: 'pay_1' },
  list_refunds: { applicationId: 'app_1', paymentId: 'pay_1' },
  get_reporting_currency: { applicationId: 'app_1' },
  get_billing_stats: { applicationId: 'app_1' },
  set_plan_price: { applicationId: 'app_1', plan: 'pro', currency: 'INR', amount: 149900 },
  archive_plan_price: { applicationId: 'app_1', plan: 'pro', currency: 'INR' },
  create_coupon: { applicationId: 'app_1', code: 'LAUNCH', discountType: 'PERCENT', basisPoints: 1500 },
  update_coupon: { applicationId: 'app_1', code: 'launch', active: false },
  set_reporting_currency: { applicationId: 'app_1', reportingCurrency: 'EUR' },
};

function tool(name: string) {
  const found = tools.find((each) => each.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

describe('@rekey.dev/mcp billing tools', () => {
  let server: Server;
  let url: string;
  const requests: Recorded[] = [];
  const answers = new Map<string, { status: number; body: unknown }>();
  let operator: AdminClient;
  let adminOnly: AdminClient;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        const key = `${req.method} ${req.url}`;
        requests.push({ key, body: raw === '' ? undefined : JSON.parse(raw), auth: req.headers.authorization });
        const answer = answers.get(key) ?? { status: 200, body: { success: true, data: { answered: key } } };
        res.statusCode = answer.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    operator = new AdminClient({ apiUrl: url, adminKey: ADMIN_KEY, operatorToken: OPERATOR_TOKEN });
    adminOnly = new AdminClient({ apiUrl: url, adminKey: ADMIN_KEY });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests.length = 0;
    answers.clear();
  });

  /** Run a tool the way the server does: arguments through its schema first. */
  async function call(name: string, args: Record<string, unknown>, client: AdminClient = operator): Promise<unknown> {
    const found = tool(name);
    return found.execute(client, found.inputSchema.parse(args));
  }

  // ---------- credentials ----------

  it.each([...READ_TOOLS, ...WRITE_TOOLS])('%s carries the operator token, never the admin key', async (name) => {
    await call(name, MINIMAL_ARGS[name]!);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.auth).toBe(`Bearer ${OPERATOR_TOKEN}`);
  });

  it.each(WRITE_TOOLS)('%s is refused without an operator token, and sends nothing', async (name) => {
    await expect(call(name, MINIMAL_ARGS[name]!, adminOnly)).rejects.toMatchObject({
      name: 'AdminApiError',
      code: 'OPERATOR_TOKEN_MISSING',
      message: 'This write tool requires an operator personal-access-token.',
      fix: expect.stringContaining('applications:write'),
    });
    expect(requests).toEqual([]);
  });

  it.each(READ_TOOLS)('%s is refused without an operator token, naming the read scope', async (name) => {
    await expect(call(name, MINIMAL_ARGS[name]!, adminOnly)).rejects.toMatchObject({
      code: 'OPERATOR_TOKEN_MISSING',
      fix: expect.stringContaining('scoped to read)'),
    });
    expect(requests).toEqual([]);
  });

  it.each(WRITE_TOOLS)('%s says it is a write, and when to use it', (name) => {
    const { description } = tool(name);
    expect(description.startsWith('WRITE')).toBe(true);
    expect(description).toContain('REKEY_OPERATOR_TOKEN');
    expect(description).toContain('applications:write');
    expect(description).toContain('only when the user explicitly asks');
  });

  it('a server scope rejection reaches the caller with its code and fix', async () => {
    answers.set(`PUT ${APP}/billing/reporting-currency`, {
      status: 403,
      body: { success: false, error: { code: 'SCOPE_INSUFFICIENT', message: "This action requires the 'billing:write' scope.", fix: 'Mint a token with billing:write.' } },
    });
    await expect(call('set_reporting_currency', { applicationId: 'app_1', reportingCurrency: 'EUR' })).rejects.toMatchObject({
      name: 'AdminApiError',
      code: 'SCOPE_INSUFFICIENT',
      fix: 'Mint a token with billing:write.',
      statusCode: 403,
    });
  });

  // ---------- reads ----------

  it('recent_billing_events sends every filter as the route names it and returns the page', async () => {
    const key =
      `GET ${APP}/billing/events?type=checkout.price_fallback%2Cpayment.refunded&tier=PERMANENT&endUserId=eu_1&subscriptionId=sub_1` +
      '&paymentId=pay_1&currency=INR&from=2026-10-01T00%3A00%3A00Z&to=2026-10-08T00%3A00%3A00Z&limit=20&cursor=99';
    const page = { items: [{ id: 'be_1', type: 'payment.refunded', amount: 500, currency: 'JPY' }], nextCursor: '41' };
    answers.set(key, { status: 200, body: { success: true, data: page } });
    const out = await call('recent_billing_events', {
      applicationId: 'app_1',
      type: ['checkout.price_fallback', 'payment.refunded'],
      tier: 'PERMANENT',
      endUserId: 'eu_1',
      subscriptionId: 'sub_1',
      paymentId: 'pay_1',
      currency: 'inr',
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-08T00:00:00Z',
      limit: 20,
      cursor: '99',
    });
    expect(requests).toEqual([{ key, body: undefined, auth: `Bearer ${OPERATOR_TOKEN}` }]);
    expect(out).toEqual(page);
    await call('recent_billing_events', { applicationId: 'app_1' });
    expect(requests[1]?.key).toBe(`GET ${APP}/billing/events`);
  });

  it('recent_billing_events asks for the actors of the page when told to, and returns them', async () => {
    const page = {
      items: [{ id: 'be_1', type: 'payment.recorded', endUserId: 'eu_1' }],
      nextCursor: null,
      actors: { endUsers: [{ id: 'eu_1', state: 'erased', email: null }], operators: [] },
    };
    answers.set(`GET ${APP}/billing/events?limit=5&include=actors`, { status: 200, body: { success: true, data: page } });
    expect(await call('recent_billing_events', { applicationId: 'app_1', limit: 5, include: ['actors'] })).toEqual(page);
    expect(tool('recent_billing_events').description).toContain('include: ["actors"]');
  });

  it('preview_checkout_routing posts the buyer and the coupon code, and returns the preview', async () => {
    const preview = { country: 'IN', countrySource: 'declared', localPrices: 'trusted', onUnavailableCurrency: 'fallback', items: [{ summary: 'A buyer in India pays ₹1,499.00.' }] };
    answers.set(`POST ${APP}/billing/checkout/preview`, { status: 200, body: { success: true, data: preview } });
    const out = await call('preview_checkout_routing', {
      applicationId: 'app_1',
      country: 'IN',
      plan: 'pro',
      countrySource: 'declared',
      endUserId: 'eu_1',
      currency: 'INR',
      onUnavailableCurrency: 'refuse',
      provider: 'razorpay',
      couponCode: 'LAUNCH',
    });
    expect(requests).toEqual([
      {
        key: `POST ${APP}/billing/checkout/preview`,
        auth: `Bearer ${OPERATOR_TOKEN}`,
        body: {
          country: 'IN',
          plan: 'pro',
          countrySource: 'declared',
          endUserId: 'eu_1',
          currency: 'INR',
          onUnavailableCurrency: 'refuse',
          provider: 'razorpay',
          couponCode: 'LAUNCH',
        },
      },
    ]);
    expect(out).toEqual(preview);
    await call('preview_checkout_routing', { applicationId: 'app_1', country: 'IN' });
    expect(requests[1]?.body).toEqual({ country: 'IN' });
  });

  it.each([
    ['get_price_fallbacks', 'price-fallbacks'],
    ['get_billing_reconciliation', 'reconciliation'],
  ])('%s sends the period when one is given', async (name, segment) => {
    await call(name, { applicationId: 'app_1' });
    await call(name, { applicationId: 'app_1', from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z' });
    expect(requests.map((q) => q.key)).toEqual([
      `GET ${APP}/billing/${segment}`,
      `GET ${APP}/billing/${segment}?from=2026-10-01T00%3A00%3A00Z&to=2026-10-08T00%3A00%3A00Z`,
    ]);
  });

  it('get_payment reads one payment with whether it can be refunded', async () => {
    const payment = { id: 'pay/1', amount: 1900, currency: 'USD', refundable: false, refundBlockedReason: 'already_refunded' };
    answers.set(`GET ${APP}/payments/pay%2F1`, { status: 200, body: { success: true, data: payment } });
    expect(await call('get_payment', { applicationId: 'app_1', paymentId: 'pay/1' })).toEqual(payment);
    expect(requests.map((q) => q.key)).toEqual([`GET ${APP}/payments/pay%2F1`]);
  });

  it('list_refunds, get_reporting_currency and get_billing_stats read their routes', async () => {
    const refunds = { items: [{ id: 'rf_1', amount: 500, currency: 'USD', status: 'succeeded' }], page: { total: 1, limit: 10, offset: 0, hasMore: false } };
    answers.set(`GET ${APP}/payments/pay_1/refunds?limit=10&offset=0`, { status: 200, body: { success: true, data: refunds } });
    expect(await call('list_refunds', { applicationId: 'app_1', paymentId: 'pay_1', limit: 10, offset: 0 })).toEqual(refunds);
    answers.set(`GET ${APP}/billing/reporting-currency`, { status: 200, body: { success: true, data: { reportingCurrency: 'USD', name: 'US Dollar' } } });
    expect(await call('get_reporting_currency', { applicationId: 'app_1' })).toEqual({ reportingCurrency: 'USD', name: 'US Dollar' });
    await call('get_billing_stats', { applicationId: 'app_1' });
    expect(requests.map((q) => q.key)).toEqual([
      `GET ${APP}/payments/pay_1/refunds?limit=10&offset=0`,
      `GET ${APP}/billing/reporting-currency`,
      `GET ${APP}/billing/stats`,
    ]);
  });

  // ---------- writes ----------

  it('set_plan_price puts the amount and countries to the price of that currency', async () => {
    const saved = { id: 'pp_inr', currency: 'INR', amount: 149900, countries: ['IN'], isDefault: false, archived: false, registration: { status: 'NOT_REQUIRED', error: null }, amountEditable: true, liveSubscriptions: 0, openCheckouts: 0 };
    answers.set(`PUT ${APP}/plans/pro/prices/INR`, { status: 200, body: { success: true, data: saved } });
    const out = await call('set_plan_price', { applicationId: 'app_1', plan: 'pro', currency: 'inr', amount: 149900, countries: ['IN'] });
    expect(requests).toEqual([
      { key: `PUT ${APP}/plans/pro/prices/INR`, body: { amount: 149900, countries: ['IN'] }, auth: `Bearer ${OPERATOR_TOKEN}` },
    ]);
    expect(out).toEqual(saved);
    await call('set_plan_price', { applicationId: 'app_1', plan: 'pro', currency: 'INR', countries: [] });
    expect(requests[1]?.body).toEqual({ countries: [] });
  });

  it('archive_plan_price deletes the price of that currency', async () => {
    answers.set(`DELETE ${APP}/plans/pro/prices/INR`, { status: 200, body: { success: true, data: { deleted: true } } });
    expect(await call('archive_plan_price', { applicationId: 'app_1', plan: 'pro', currency: 'inr' })).toEqual({ deleted: true });
    expect(requests).toEqual([{ key: `DELETE ${APP}/plans/pro/prices/INR`, body: undefined, auth: `Bearer ${OPERATOR_TOKEN}` }]);
  });

  it('create_coupon posts a percentage coupon, or one amount per currency', async () => {
    await call('create_coupon', {
      applicationId: 'app_1',
      code: 'LAUNCH',
      discountType: 'PERCENT',
      basisPoints: 1500,
      currencies: ['USD'],
      planSlugs: ['pro'],
      startsAt: '2026-11-01T00:00:00Z',
      endsAt: '2026-12-01T00:00:00Z',
      maxRedemptions: 100,
      maxRedemptionsPerUser: 1,
    });
    const amounts = [
      { currency: 'USD', amountOff: 500 },
      { currency: 'JPY', amountOff: 500 },
    ];
    await call('create_coupon', { applicationId: 'app_1', code: 'FIVEOFF', discountType: 'AMOUNT', amounts });
    expect(requests).toEqual([
      {
        key: `POST ${APP}/coupons`,
        auth: `Bearer ${OPERATOR_TOKEN}`,
        body: {
          code: 'LAUNCH',
          discountType: 'PERCENT',
          basisPoints: 1500,
          currencies: ['USD'],
          planSlugs: ['pro'],
          startsAt: '2026-11-01T00:00:00Z',
          endsAt: '2026-12-01T00:00:00Z',
          maxRedemptions: 100,
          maxRedemptionsPerUser: 1,
        },
      },
      { key: `POST ${APP}/coupons`, auth: `Bearer ${OPERATOR_TOKEN}`, body: { code: 'FIVEOFF', discountType: 'AMOUNT', amounts } },
    ]);
  });

  it('update_coupon patches only the fields sent, with the whole set of amounts', async () => {
    const amounts = [{ currency: 'EUR', amountOff: 450 }];
    await call('update_coupon', { applicationId: 'app_1', code: 'fiveoff', active: false, amounts, planSlugs: [] });
    expect(requests).toEqual([
      { key: `PATCH ${APP}/coupons/fiveoff`, auth: `Bearer ${OPERATOR_TOKEN}`, body: { active: false, amounts, planSlugs: [] } },
    ]);
    expect(tool('update_coupon').description).toContain('REPLACES the whole set');
  });

  it('update_coupon sends an end date and caps, and null to remove one', async () => {
    const body = { endsAt: '2026-12-31T23:59:59Z', maxRedemptions: 500, maxRedemptionsPerUser: null };
    await call('update_coupon', { applicationId: 'app_1', code: 'launch', ...body });
    await call('update_coupon', { applicationId: 'app_1', code: 'launch', endsAt: null });
    expect(requests.map((q) => q.body)).toEqual([body, { endsAt: null }]);
    expect(tool('update_coupon').description).toContain('COUPON_LIMIT_BELOW_REDEEMED');
  });

  it('set_reporting_currency puts the code upper-cased', async () => {
    await call('set_reporting_currency', { applicationId: 'app_1', reportingCurrency: 'jpy' });
    expect(requests).toEqual([
      { key: `PUT ${APP}/billing/reporting-currency`, body: { reportingCurrency: 'JPY' }, auth: `Bearer ${OPERATOR_TOKEN}` },
    ]);
  });

  // ---------- input schemas ----------

  it.each([
    ['set_plan_price', { applicationId: 'app_1', plan: 'pro', currency: 'INR', amount: 1499.5 }],
    ['set_plan_price', { applicationId: 'app_1', plan: 'pro', currency: 'INR', amount: 0 }],
    ['set_plan_price', { applicationId: 'app_1', plan: 'pro', currency: 'RUPEE', amount: 100 }],
    ['create_coupon', { applicationId: 'app_1', code: 'X', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 5.5 }] }],
    ['create_coupon', { applicationId: 'app_1', code: 'X', discountType: 'PERCENT', basisPoints: 10001 }],
    ['preview_checkout_routing', { applicationId: 'app_1', country: 'IND' }],
    ['recent_billing_events', { applicationId: 'app_1', tier: 'forever' }],
  ])('%s refuses %j', (name, args) => {
    expect(tool(name).inputSchema.safeParse(args).success).toBe(false);
  });

  it('every amount input states its unit, and is published as an integer', () => {
    const price = zodToJsonSchema(tool('set_plan_price').inputSchema).properties!.amount!;
    expect(price.type).toBe('integer');
    expect(price.description).toContain(UNITS);
    for (const name of ['create_coupon', 'update_coupon']) {
      const amountOff = zodToJsonSchema(tool(name).inputSchema).properties!.amounts!.items!.properties!.amountOff!;
      expect(amountOff.type).toBe('integer');
      expect(amountOff.description).toContain(UNITS);
    }
  });
});
