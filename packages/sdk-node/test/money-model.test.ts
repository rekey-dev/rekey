/**
 * The money model on the wire: what each method sends (method, path, query,
 * body, headers) and that it hands back the API's answer untouched. Every
 * answer is a fixture the real Zod schema has parsed (./fixtures/money.ts).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BILLING_MONEY_ERROR_CODES,
  Rekey,
  RekeyError,
  RekeyOperator,
  formatMoney,
  isBillingMoneyError,
  minorUnitExponent,
  priceFallbackMessage,
  refundBlockedMessage,
  sellableCurrencies,
  validatePriceAmount,
} from '../src/index.js';
import * as F from './fixtures/money.js';

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function refusal(status: number, code: string): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message: `${code}.`, fix: 'Read the docs.' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function sentBy(spy: ReturnType<typeof vi.fn>, call = 0): Sent {
  const [url, init] = spy.mock.calls[call]! as [string, RequestInit];
  return {
    url,
    method: init.method ?? 'GET',
    headers: init.headers as Record<string, string>,
    body: init.body === undefined ? undefined : JSON.parse(init.body as string),
  };
}

const API = 'https://api.example.com';
const APP = `${API}/api/v1/tenant/applications/app_1`;
const TOKEN = 'jwt.user.token';

function rekey(fetchImpl: typeof fetch, extra: { visitorCountryHint?: string } = {}): Rekey {
  return new Rekey({ apiUrl: API, secretKey: 'rp_live_token', fetch: fetchImpl, ...extra });
}

function operator(fetchImpl: typeof fetch): RekeyOperator {
  return new RekeyOperator({ apiUrl: API, operatorToken: 'rp_op_token', applicationId: 'app_1', fetch: fetchImpl });
}

describe('billing.getPlans', () => {
  it('asks for the price of a buyer in a country, for a signed-in buyer', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.PUBLIC_PLANS));
    const plans = await rekey(spy).billing.getPlans({ limit: 10 }, { country: 'in', accessToken: TOKEN });

    const sent = sentBy(spy);
    expect(sent.method).toBe('GET');
    expect(sent.url).toBe(`${API}/api/v1/billing/plans?limit=10&country=IN`);
    expect(sent.headers['X-Rekey-User-Token']).toBe(TOKEN);
    expect(sent.headers.Authorization).toBe('Bearer rp_live_token');
    expect(plans).toEqual(F.PUBLIC_PLANS);
    expect(plans.items[0]!.price?.formatted).toBe('₹1,499.00');
  });

  it('sends no country and no user token when neither is given', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.PUBLIC_PLANS));
    await rekey(spy).billing.getPlans();

    const sent = sentBy(spy);
    expect(sent.url).toBe(`${API}/api/v1/billing/plans`);
    expect(sent.headers['X-Rekey-User-Token']).toBeUndefined();
  });
});

describe('billing.createCheckout', () => {
  const input = {
    planSlug: 'pro',
    currency: 'INR',
    onUnavailableCurrency: 'fallback' as const,
    country: 'IN',
    successUrl: 'https://yourapp.com/ok',
    cancelUrl: 'https://yourapp.com/cancel',
    couponCode: 'LAUNCH50',
  };

  it('posts the currency, the fallback rule and the country in the body, and returns the price charged', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.CHECKOUT_WITH_FALLBACK, 201));
    const checkout = await rekey(spy).billing.createCheckout(TOKEN, input);

    const sent = sentBy(spy);
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(`${API}/api/v1/billing/checkout`);
    expect(sent.body).toEqual(input);
    expect(sent.headers['X-Rekey-User-Token']).toBe(TOKEN);
    expect(checkout).toEqual(F.CHECKOUT_WITH_FALLBACK);
    expect(checkout.price?.currency).toBe('USD');
    expect(checkout.priceFallback?.requested.currency).toBe('INR');
  });

  it('never sends the removed x-country header, and carries the country hint in its own header', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.CHECKOUT_WITH_FALLBACK, 201));
    await rekey(spy, { visitorCountryHint: 'in' }).billing.createCheckout(TOKEN, input);

    const names = Object.keys(sentBy(spy).headers).map((name) => name.toLowerCase());
    expect(names).not.toContain('x-country');
    expect(names).toContain('x-rekey-visitor-country-hint');
    expect(sentBy(spy).headers['X-Rekey-Visitor-Country-Hint']).toBe('IN');
  });

  it.each(['BILLING_CURRENCY_CONFLICT', 'BILLING_NO_PROVIDER_FOR_CURRENCY', 'BILLING_FIELD_REMOVED', 'COUPON_CURRENCY_NOT_COVERED'])(
    'raises %s as a RekeyError the money guard recognises',
    async (code) => {
      const spy = vi.fn().mockResolvedValue(refusal(409, code));
      const err: unknown = await rekey(spy).billing.createCheckout(TOKEN, input).catch((caught: unknown) => caught);

      expect(err).toBeInstanceOf(RekeyError);
      expect(isBillingMoneyError(err)).toBe(true);
      expect((err as RekeyError).code).toBe(code);
      expect((err as RekeyError).fix).toBe('Read the docs.');
    },
  );
});

describe('billing.validateCoupon', () => {
  it('posts the quote request and returns the quote with its written amounts', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.COUPON_QUOTE));
    const request = { code: 'LAUNCH50', planSlug: 'pro', country: 'IN' };
    const quote = await rekey(spy).billing.validateCoupon(TOKEN, request);

    const sent = sentBy(spy);
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(`${API}/api/v1/billing/coupons/validate`);
    expect(sent.body).toEqual(request);
    expect(sent.headers['X-Rekey-User-Token']).toBe(TOKEN);
    expect(quote).toEqual(F.COUPON_QUOTE);
    expect(quote.formatted).toEqual({ discount: '₹750.00', total: '₹749.00' });
  });
});

describe('RekeyOperator', () => {
  it('refuses a token that is not an operator token, and a missing Application', () => {
    expect(() => new RekeyOperator({ apiUrl: API, operatorToken: 'rp_live_secret', applicationId: 'app_1' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID_OPERATOR_TOKEN' }),
    );
    expect(() => new RekeyOperator({ apiUrl: API, operatorToken: 'rp_op_token', applicationId: '' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_MISSING_APPLICATION_ID' }),
    );
  });

  it('sends the operator token as the bearer and encodes the Application id', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.STATS));
    const client = new RekeyOperator({ apiUrl: API, operatorToken: 'rp_op_token', applicationId: 'app/1', fetch: spy });
    await client.billing.stats();

    expect(sentBy(spy).url).toBe(`${API}/api/v1/tenant/applications/app%2F1/billing/stats`);
    expect(sentBy(spy).headers.Authorization).toBe('Bearer rp_op_token');
  });

  it('forApplication keeps the token and changes the Application', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.STATS));
    await operator(spy).forApplication('app_2').billing.stats();

    expect(sentBy(spy).url).toBe(`${API}/api/v1/tenant/applications/app_2/billing/stats`);
    expect(sentBy(spy).headers.Authorization).toBe('Bearer rp_op_token');
  });

  it('maps a refusal to a RekeyError with its status', async () => {
    const spy = vi.fn().mockResolvedValue(refusal(403, 'APP_ACCESS_DENIED'));
    await expect(operator(spy).billing.stats()).rejects.toMatchObject({ code: 'APP_ACCESS_DENIED', statusCode: 403 });
  });
});

describe('operator.plans', () => {
  it('list pages the operator plan list', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.OPERATOR_PLANS));
    const plans = await operator(spy).plans.list({ limit: 25, offset: 50 });

    expect(sentBy(spy).method).toBe('GET');
    expect(sentBy(spy).url).toBe(`${APP}/plans?limit=25&offset=50`);
    expect(plans).toEqual(F.OPERATOR_PLANS);
  });

  it('create POSTs the default price as `price`, and update PATCHes the plan by slug', async () => {
    const plan = F.OPERATOR_PLANS.items[0]!;
    const spy = vi.fn().mockImplementation(async () => ok(plan));
    const created = await operator(spy).plans.create({ slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 1900 } });
    expect(sentBy(spy)).toMatchObject({ method: 'POST', url: `${APP}/plans` });
    expect(sentBy(spy).body).toEqual({ slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 1900 } });
    expect(created).toEqual(plan);

    await operator(spy).plans.update('pro/annual', { price: null });
    expect(sentBy(spy, 1)).toMatchObject({ method: 'PATCH', url: `${APP}/plans/pro%2Fannual`, body: { price: null } });

    await operator(spy).plans.update('pro', { localPrices: 'OFF' });
    expect(sentBy(spy, 2).body).toEqual({ localPrices: 'OFF' });
  });

  it('prices.list reads a plan by slug or id from the plan list', async () => {
    const spy = vi.fn().mockImplementation(async () => ok(F.OPERATOR_PLANS));
    const bySlug = await operator(spy).plans.prices.list('pro');
    const byId = await operator(spy).plans.prices.list('plan_1');

    expect(sentBy(spy).url).toBe(`${APP}/plans?limit=100&offset=0`);
    expect(bySlug).toEqual(F.OPERATOR_PLANS.items[0]!.prices);
    expect(byId).toEqual(bySlug);
  });

  it('prices.list raises PLAN_NOT_FOUND once the last page has been read', async () => {
    const spy = vi.fn().mockImplementation(async () => ok(F.OPERATOR_PLANS));
    await expect(operator(spy).plans.prices.list('missing')).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND', statusCode: 404 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('prices.set PUTs the amount and countries to the upper-cased currency', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.PLAN_PRICE));
    const price = await operator(spy).plans.prices.set('pro', 'inr', { amount: 149900, countries: ['IN'] });

    const sent = sentBy(spy);
    expect(sent.method).toBe('PUT');
    expect(sent.url).toBe(`${APP}/plans/pro/prices/INR`);
    expect(sent.body).toEqual({ amount: 149900, countries: ['IN'] });
    expect(price).toEqual(F.PLAN_PRICE);
  });

  it('prices.archive DELETEs the price', async () => {
    const spy = vi.fn().mockResolvedValue(ok({ deleted: true }));
    const result = await operator(spy).plans.prices.archive('pro', 'INR');

    expect(sentBy(spy).method).toBe('DELETE');
    expect(sentBy(spy).url).toBe(`${APP}/plans/pro/prices/INR`);
    expect(sentBy(spy).body).toBeUndefined();
    expect(result).toEqual({ deleted: true });
  });
});

describe('operator.coupons', () => {
  it('list returns coupons with what each took off per currency', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.COUPONS_WITH_STATS));
    const coupons = await operator(spy).coupons.list({ limit: 100 });

    expect(sentBy(spy).url).toBe(`${APP}/coupons?limit=100`);
    expect(coupons).toEqual(F.COUPONS_WITH_STATS);
  });

  it('get reads one coupon by its encoded code', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.AMOUNT_COUPON));
    const coupon = await operator(spy).coupons.get('FIVE OFF');

    expect(sentBy(spy).method).toBe('GET');
    expect(sentBy(spy).url).toBe(`${APP}/coupons/FIVE%20OFF`);
    expect(coupon.coveredCurrencies).toEqual(['INR', 'USD']);
  });

  it('create posts an amount per currency, with the idempotency key when given', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.AMOUNT_COUPON, 201));
    const body = {
      code: 'FIVEOFF',
      discountType: 'AMOUNT' as const,
      amounts: [
        { currency: 'USD', amountOff: 500 },
        { currency: 'INR', amountOff: 40000 },
      ],
    };
    const coupon = await operator(spy).coupons.create(body, { idempotencyKey: 'k-1' });

    const sent = sentBy(spy);
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(`${APP}/coupons`);
    expect(sent.body).toEqual(body);
    expect(sent.headers['Idempotency-Key']).toBe('k-1');
    expect(coupon).toEqual(F.AMOUNT_COUPON);
  });

  it('create posts basis points for a percentage, with no idempotency header by default', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.PERCENT_COUPON, 201));
    const body = { code: 'LAUNCH', discountType: 'PERCENT' as const, basisPoints: 1500, currencies: ['USD'] };
    await operator(spy).coupons.create(body);

    expect(sentBy(spy).body).toEqual(body);
    expect(sentBy(spy).headers['Idempotency-Key']).toBeUndefined();
  });

  it('update PATCHes the fields sent', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.AMOUNT_COUPON));
    const body = { amounts: [{ currency: 'USD', amountOff: 500 }], active: false };
    await operator(spy).coupons.update('FIVEOFF', body);

    expect(sentBy(spy).method).toBe('PATCH');
    expect(sentBy(spy).url).toBe(`${APP}/coupons/FIVEOFF`);
    expect(sentBy(spy).body).toEqual(body);
  });
});

describe('operator.coupons.update, end date and caps', () => {
  it('sends a value or null for each, and passes the refusal for a cap below what is redeemed through', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.AMOUNT_COUPON));
    const body = { endsAt: '2026-12-31T23:59:59.000Z', maxRedemptions: 500, maxRedemptionsPerUser: null };
    await operator(spy).coupons.update('FIVEOFF', body);
    expect(sentBy(spy).method).toBe('PATCH');
    expect(sentBy(spy).body).toEqual(body);

    const refused = vi.fn().mockResolvedValue(refusal(409, 'COUPON_LIMIT_BELOW_REDEEMED'));
    const err = await operator(refused).coupons.update('FIVEOFF', { maxRedemptions: 1 }).catch((e: unknown) => e);
    expect(isBillingMoneyError(err)).toBe(true);
    expect((err as RekeyError).code).toBe('COUPON_LIMIT_BELOW_REDEEMED');
  });
});

describe('operator.payments', () => {
  it('list sends its filters, dates as ISO 8601', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.PAYMENTS));
    const payments = await operator(spy).payments.list({
      status: 'PARTIALLY_REFUNDED',
      from: new Date('2026-10-01T00:00:00.000Z'),
      sort: 'amount',
      order: 'asc',
      limit: 10,
    });

    const url = new URL(sentBy(spy).url);
    expect(url.pathname).toBe('/api/v1/tenant/applications/app_1/payments');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'PARTIALLY_REFUNDED',
      from: '2026-10-01T00:00:00.000Z',
      sort: 'amount',
      order: 'asc',
      limit: '10',
    });
    expect(payments.items[0]!.refundedAmount).toBe(500);
  });

  it('get reads one payment, with whether it can be refunded', async () => {
    const [row] = F.PAYMENTS.items;
    const blocked = { ...row!, status: 'REFUNDED', refundedAmount: 1900, refundable: false, refundBlockedReason: 'already_refunded' };
    const spy = vi.fn().mockResolvedValue(ok(blocked));
    const payment = await operator(spy).payments.get('pay/1');

    expect(sentBy(spy).method).toBe('GET');
    expect(sentBy(spy).url).toBe(`${APP}/payments/pay%2F1`);
    expect(payment.refundable).toBe(false);
    expect(refundBlockedMessage(payment.refundBlockedReason!)).toBe('This payment has been refunded in full. Nothing remains.');
  });

  it('refunds.list reads the refunds of one payment', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.REFUNDS));
    const refunds = await operator(spy).payments.refunds.list('pay_1', { limit: 5 });

    expect(sentBy(spy).method).toBe('GET');
    expect(sentBy(spy).url).toBe(`${APP}/payments/pay_1/refunds?limit=5`);
    expect(refunds).toEqual(F.REFUNDS);
  });
});

describe('operator.billingLog', () => {
  it('events.list sends the cursor and every filter, several types joined by commas', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.LOG_PAGE_ONE));
    const page = await operator(spy).billingLog.events.list({
      cursor: '99',
      limit: 20,
      type: ['checkout.price_fallback', 'payment.not_applied'],
      tier: 'PERMANENT',
      currency: 'INR',
      endUserId: 'eu_1',
      subscriptionId: 'sub_1',
      paymentId: 'pay_1',
      from: '2026-10-01T00:00:00.000Z',
      to: new Date('2026-10-08T00:00:00.000Z'),
    });

    const url = new URL(sentBy(spy).url);
    expect(sentBy(spy).method).toBe('GET');
    expect(url.pathname).toBe('/api/v1/tenant/applications/app_1/billing/events');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      cursor: '99',
      limit: '20',
      type: 'checkout.price_fallback,payment.not_applied',
      tier: 'PERMANENT',
      currency: 'INR',
      endUserId: 'eu_1',
      subscriptionId: 'sub_1',
      paymentId: 'pay_1',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-08T00:00:00.000Z',
    });
    expect(page).toEqual(F.LOG_PAGE_ONE);
  });

  it('events.list with no options sends no query, and one type is sent alone', async () => {
    const spy = vi.fn().mockImplementation(async () => ok(F.LOG_PAGE_TWO));
    await operator(spy).billingLog.events.list();
    await operator(spy).billingLog.events.list({ type: 'payment.refunded' });

    expect(sentBy(spy, 0).url).toBe(`${APP}/billing/events`);
    expect(sentBy(spy, 1).url).toBe(`${APP}/billing/events?type=payment.refunded`);
  });

  it('include asks for the actors of the page, on the log, on every later page and on a trail', async () => {
    const spy = vi.fn().mockImplementation(async () => ok(F.LOG_PAGE_WITH_ACTORS));
    const page = await operator(spy).billingLog.events.list({ include: ['actors'] });
    expect(sentBy(spy, 0).url).toBe(`${APP}/billing/events?include=actors`);
    expect(page.actors?.endUsers).toEqual([{ id: 'eu_1', state: 'known', email: 'buyer@example.com' }]);
    expect(page.actors?.operators[0]?.name).toBe('Olga Owner');

    await operator(spy).billingLog.forPayment('pay_1', { include: ['actors'], limit: 5 });
    expect(sentBy(spy, 1).url).toBe(`${APP}/billing/payments/pay_1/events?limit=5&include=actors`);

    const paged = vi.fn().mockResolvedValueOnce(ok(F.LOG_PAGE_ONE)).mockResolvedValueOnce(ok(F.LOG_PAGE_TWO));
    for await (const each of operator(paged).billingLog.events.pages({ include: ['actors'] })) expect(each.actors).toBeNull();
    expect(sentBy(paged, 1).url).toBe(`${APP}/billing/events?cursor=42&include=actors`);
  });

  it('events.pages follows nextCursor to the last page, keeping the filters', async () => {
    const spy = vi.fn().mockResolvedValueOnce(ok(F.LOG_PAGE_ONE)).mockResolvedValueOnce(ok(F.LOG_PAGE_TWO));
    const pages = [];
    for await (const page of operator(spy).billingLog.events.pages({ tier: 'PERMANENT', limit: 1 })) pages.push(page);

    expect(pages).toEqual([F.LOG_PAGE_ONE, F.LOG_PAGE_TWO]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(sentBy(spy, 0).url).toBe(`${APP}/billing/events?limit=1&tier=PERMANENT`);
    expect(sentBy(spy, 1).url).toBe(`${APP}/billing/events?cursor=42&limit=1&tier=PERMANENT`);
  });

  it('events.pages makes no further request once the reader stops', async () => {
    const spy = vi.fn().mockImplementation(async () => ok(F.LOG_PAGE_ONE));
    for await (const page of operator(spy).billingLog.events.pages()) {
      expect(page.nextCursor).toBe('42');
      break;
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('events.iterate yields every entry across pages, newest first', async () => {
    const spy = vi.fn().mockResolvedValueOnce(ok(F.LOG_PAGE_ONE)).mockResolvedValueOnce(ok(F.LOG_PAGE_TWO));
    const seen: string[] = [];
    for await (const entry of operator(spy).billingLog.events.iterate()) seen.push(`${entry.seq}:${entry.type}`);

    expect(seen).toEqual(['42:checkout.price_fallback', '41:payment.refunded']);
  });

  it.each([
    ['forSubscription', 'sub_1', '/billing/subscriptions/sub_1/events'],
    ['forPayment', 'pay_1', '/billing/payments/pay_1/events'],
    ['forEndUser', 'eu_1', '/end-users/eu_1/billing-events'],
  ] as const)('%s reads the trail of one record', async (method, id, path) => {
    const spy = vi.fn().mockResolvedValue(ok(F.LOG_PAGE_TWO));
    const page = await operator(spy).billingLog[method](id, { limit: 100, type: 'payment.refunded' });

    expect(sentBy(spy).method).toBe('GET');
    expect(sentBy(spy).url).toBe(`${APP}${path}?limit=100&type=payment.refunded`);
    expect(page).toEqual(F.LOG_PAGE_TWO);
  });

  it('priceFallbacks reads the grouped counts for a period', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.PRICE_FALLBACKS));
    const summary = await operator(spy).billingLog.priceFallbacks({ from: '2026-10-05T09:00:00.000Z' });

    expect(sentBy(spy).url).toBe(`${APP}/billing/price-fallbacks?from=2026-10-05T09%3A00%3A00.000Z`);
    expect(summary).toEqual(F.PRICE_FALLBACKS);
  });

  it('reconciliation reads the report, with no query for the default period', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.RECONCILIATION));
    const report = await operator(spy).billingLog.reconciliation();

    expect(sentBy(spy).method).toBe('GET');
    expect(sentBy(spy).url).toBe(`${APP}/billing/reconciliation`);
    expect(report.counts.payment_without_event).toBe(1);
    expect(report).toEqual(F.RECONCILIATION);
  });
});

describe('operator.billing', () => {
  it('getReportingCurrency reads it', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.REPORTING_CURRENCY));
    const result = await operator(spy).billing.getReportingCurrency();

    expect(sentBy(spy).method).toBe('GET');
    expect(sentBy(spy).url).toBe(`${APP}/billing/reporting-currency`);
    expect(result).toEqual(F.REPORTING_CURRENCY);
  });

  it('setReportingCurrency PUTs the code', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.REPORTING_CURRENCY));
    await operator(spy).billing.setReportingCurrency('EUR');

    expect(sentBy(spy).method).toBe('PUT');
    expect(sentBy(spy).url).toBe(`${APP}/billing/reporting-currency`);
    expect(sentBy(spy).body).toEqual({ reportingCurrency: 'EUR' });
  });

  it('getConfig reads the billing settings off the Application', async () => {
    const billingConfig = F.BILLING_CONFIG;
    const spy = vi.fn().mockResolvedValue(ok({ id: 'app_1', slug: 'shop', billingConfig }));
    const config = await operator(spy).billing.getConfig();

    expect(sentBy(spy).method).toBe('GET');
    expect(sentBy(spy).url).toBe(APP);
    expect(config).toEqual(billingConfig);
    expect(config.onUnavailableCurrency).toBe('fallback');
  });

  it('stats returns one row per currency and the unverified money apart', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.STATS));
    const stats = await operator(spy).billing.stats();

    expect(sentBy(spy).url).toBe(`${APP}/billing/stats`);
    expect(stats.mrr.map((row) => row.currency)).toEqual(['EUR', 'INR', 'USD']);
    expect(stats.unverified).toEqual([{ currency: 'USD', amountCents: 190000, payments: 1 }]);
  });

  it('previewRouting posts the buyer, the plan and the coupon', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.ROUTING_PREVIEW));
    const input = { country: 'IN', plan: 'pro', couponCode: 'FIVEOFF' };
    const preview = await operator(spy).billing.previewRouting(input);

    const sent = sentBy(spy);
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(`${APP}/billing/checkout/preview`);
    expect(sent.body).toEqual(input);
    expect(preview.items[0]!.coupon?.discount?.formatted.total).toBe('₹1,099.00');
  });

  it('providers lists what each provider module can charge', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.PROVIDER_MODULES));
    const { providers } = await operator(spy).billing.providers();

    expect(sentBy(spy).url).toBe(`${APP}/billing/providers`);
    expect(providers[0]!.supportedCurrencies).toEqual(['INR', 'USD']);
  });

  it('providerCurrencies lists what each configured account charges', async () => {
    const spy = vi.fn().mockResolvedValue(ok(F.PROVIDER_CURRENCIES));
    const rows = await operator(spy).billing.providerCurrencies();

    expect(sentBy(spy).url).toBe(`${APP}/billing-credentials`);
    expect(rows).toEqual(F.PROVIDER_CURRENCIES);
  });
});

describe('money helpers re-exported from the registry', () => {
  it('formats, measures and validates without the caller knowing an exponent', () => {
    expect(formatMoney(149900, 'INR')).toBe('₹1,499.00');
    expect(formatMoney(5000, 'JPY')).toBe('¥5,000');
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(validatePriceAmount('USD', 1999)).toEqual({ ok: true });
    expect(validatePriceAmount('HUF', 500050).ok).toBe(false);
    expect(sellableCurrencies()).toContain('USD');
    expect(sellableCurrencies()).not.toContain('KWD');
  });

  it('writes the fallback sentence from a checkout result', () => {
    expect(priceFallbackMessage(F.CHECKOUT_WITH_FALLBACK.priceFallback!)).toBe(
      'Prices in INR are not available yet. You will pay $19.00.',
    );
  });

  it('exports the money error codes', () => {
    expect(BILLING_MONEY_ERROR_CODES).toContain('BILLING_FIELD_REMOVED');
  });
});
