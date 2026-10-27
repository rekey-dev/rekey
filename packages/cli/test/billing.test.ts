/** `rekey billing …`, through the compiled binary against the stub server. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR_TOKEN, runCli, startStubServer, valid, type StubServer } from './helpers.js';

const APP = '/api/v1/tenant/applications/app_1';
const AUTH = `Bearer ${OPERATOR_TOKEN}`;

function entry(over: Record<string, unknown>) {
  return valid('BillingLogEntrySchema', {
    id: 'be_1',
    seq: '41',
    applicationId: 'app_1',
    type: 'payment.recorded',
    tier: 'PERMANENT',
    occurredAt: '2026-10-01T09:00:00.000Z',
    recordedAt: '2026-10-01T09:00:01.000Z',
    actor: { type: 'provider', id: null },
    endUserId: 'eu_1',
    subscriptionId: 'sub_1',
    checkoutSessionId: null,
    paymentId: 'pay_1',
    refundId: null,
    planId: 'plan_pro',
    planPriceId: 'pp_usd',
    couponId: null,
    provider: 'stripe',
    providerEventId: 'evt_1',
    currency: 'USD',
    amount: 1900,
    data: { priceCharged: null, discountAmount: 0, providerPaymentId: 'in_1', verification: 'verified' },
    ...over,
  });
}

const PAYMENT = entry({});
const YEN_REFUND = entry({
  id: 'be_2',
  seq: '40',
  type: 'payment.refunded',
  paymentId: 'pay_2',
  refundId: 'rf_2',
  subscriptionId: null,
  currency: 'JPY',
  amount: 500,
  data: { refundedAmount: 500, totalRefunded: 500, providerRefundId: null, initiatedBy: 'operator', reasonCode: null },
});
const SETTING = entry({
  id: 'be_3',
  seq: '39',
  type: 'settings.reporting_currency_changed',
  actor: { type: 'operator', id: 'op_1' },
  endUserId: null,
  subscriptionId: null,
  paymentId: null,
  planId: null,
  planPriceId: null,
  provider: null,
  providerEventId: null,
  currency: null,
  amount: null,
  data: { before: 'USD', after: 'EUR' },
});

describe('rekey billing', () => {
  let stub: StubServer;
  let env: Record<string, string>;

  beforeAll(async () => {
    stub = await startStubServer();
    env = { REKEY_URL: stub.url, REKEY_OPERATOR_TOKEN: OPERATOR_TOKEN };
  });

  afterAll(async () => {
    await stub.close();
  });

  it('billing commands need an operator token', async () => {
    stub.reset();
    const r = await runCli(['billing', 'log', '--app', 'app_1', '--json'], { REKEY_URL: stub.url });
    expect(r.code).toBe(1);
    const { error } = JSON.parse(r.stderr) as { error: { code: string; fix: string } };
    expect(error.code).toBe('CLI_OPERATOR_TOKEN_MISSING');
    expect(error.fix).toContain('with the read scope');
    expect(stub.requests).toEqual([]);
  });

  // ---------- billing log ----------

  it('billing log prints one line per entry, with money formatted where the entry has some', async () => {
    stub.reset();
    stub.ok(`GET ${APP}/billing/events`, valid('BillingLogPageSchema', { items: [PAYMENT, YEN_REFUND, SETTING], nextCursor: '39', actors: null }));
    const r = await runCli(['billing', 'log', '--app', 'app_1'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests).toEqual([{ key: `GET ${APP}/billing/events`, body: undefined, auth: AUTH }]);
    expect(r.stdout).toBe(
      [
        '2026-10-01T09:00:00.000Z  payment.recorded  $19.00  payment=pay_1 subscription=sub_1 end-user=eu_1 provider=stripe',
        '2026-10-01T09:00:00.000Z  payment.refunded  ¥500  payment=pay_2 refund=rf_2 end-user=eu_1 provider=stripe',
        '2026-10-01T09:00:00.000Z  settings.reporting_currency_changed  -',
        '',
        'More entries: pass --cursor 39 for the next page.',
        '',
      ].join('\n'),
    );
  });

  it('billing log sends every filter as the route names it, and --json is { items, nextCursor, actors }', async () => {
    stub.reset();
    const key =
      `GET ${APP}/billing/events?type=payment.recorded%2Cpayment.refunded&tier=DIAGNOSTIC&endUserId=eu_1&subscriptionId=sub_1` +
      '&paymentId=pay_1&currency=INR&from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-08T00%3A00%3A00.000Z&limit=20&cursor=99';
    stub.ok(key, { items: [PAYMENT], nextCursor: null, actors: null });
    const r = await runCli(
      [
        'billing', 'log', '--app', 'app_1', '--type', 'payment.recorded,payment.refunded', '--tier', 'diagnostic',
        '--end-user', 'eu_1', '--subscription', 'sub_1', '--payment', 'pay_1', '--currency', 'inr',
        '--from', '2026-10-01', '--to', '2026-10-08T00:00:00Z', '--limit', '20', '--cursor', '99', '--json',
      ],
      env,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests.map((q) => q.key)).toEqual([key]);
    expect(JSON.parse(r.stdout)).toEqual({ items: [PAYMENT], nextCursor: null, actors: null });
  });

  it('billing log --all follows nextCursor to the end', async () => {
    stub.reset();
    stub.ok(`GET ${APP}/billing/events?limit=200`, { items: [PAYMENT], nextCursor: '40', actors: null });
    stub.ok(`GET ${APP}/billing/events?limit=200&cursor=40`, { items: [YEN_REFUND], nextCursor: '39', actors: null });
    stub.ok(`GET ${APP}/billing/events?limit=200&cursor=39`, { items: [SETTING], nextCursor: null, actors: null });
    const r = await runCli(['billing', 'log', '--app', 'app_1', '--all', '--json'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests).toHaveLength(3);
    expect(JSON.parse(r.stdout)).toEqual({ items: [PAYMENT, YEN_REFUND, SETTING], nextCursor: null, actors: null });
  });

  it('billing log --include actors asks for them and prints an email or a name in place of an id', async () => {
    stub.reset();
    const BY_OPERATOR = { ...SETTING, actor: { type: 'operator', id: 'op_1' } };
    const ERASED = { ...YEN_REFUND, endUserId: 'eu_gone' };
    const actors = {
      endUsers: [
        { id: 'eu_1', state: 'known', email: 'buyer@example.com' },
        { id: 'eu_gone', state: 'erased', email: null },
      ],
      operators: [{ id: 'op_1', state: 'known', name: 'Olga Owner', email: 'olga@example.com' }],
    };
    const page = valid('BillingLogPageSchema', { items: [PAYMENT, ERASED, BY_OPERATOR], nextCursor: null, actors });
    stub.ok(`GET ${APP}/billing/events?include=actors`, page);
    const text = await runCli(['billing', 'log', '--app', 'app_1', '--include', 'actors'], env);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toBe(
      [
        '2026-10-01T09:00:00.000Z  payment.recorded  $19.00  payment=pay_1 subscription=sub_1 end-user=buyer@example.com provider=stripe',
        '2026-10-01T09:00:00.000Z  payment.refunded  ¥500  payment=pay_2 refund=rf_2 end-user=eu_gone (erased) provider=stripe',
        '2026-10-01T09:00:00.000Z  settings.reporting_currency_changed  -  by=Olga Owner <olga@example.com>',
        '',
      ].join('\n'),
    );
    const json = await runCli(['billing', 'log', '--app', 'app_1', '--include', 'actors', '--json'], env);
    expect(JSON.parse(json.stdout)).toEqual(page);
  });

  it('billing log --all --include actors names each person once across the pages', async () => {
    stub.reset();
    const known = { id: 'eu_1', state: 'known', email: 'buyer@example.com' };
    stub.ok(`GET ${APP}/billing/events?include=actors&limit=200`, {
      items: [PAYMENT],
      nextCursor: '40',
      actors: { endUsers: [known], operators: [] },
    });
    stub.ok(`GET ${APP}/billing/events?include=actors&limit=200&cursor=40`, {
      items: [YEN_REFUND],
      nextCursor: null,
      actors: { endUsers: [known], operators: [] },
    });
    const r = await runCli(['billing', 'log', '--app', 'app_1', '--all', '--include', 'actors', '--json'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ items: [PAYMENT, YEN_REFUND], nextCursor: null, actors: { endUsers: [known], operators: [] } });
  });

  it('billing log --all stops at --max and hands back the cursor to continue from', async () => {
    stub.reset();
    stub.ok(`GET ${APP}/billing/events?limit=2`, { items: [PAYMENT, YEN_REFUND], nextCursor: '39', actors: null });
    const r = await runCli(['billing', 'log', '--app', 'app_1', '--all', '--max', '2', '--json'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toEqual({ items: [PAYMENT, YEN_REFUND], nextCursor: '39', actors: null });
  });

  it.each([
    [['--tier', 'forever'], 'CLI_BILLING_TIER_INVALID'],
    [['--limit', '201'], 'CLI_BILLING_LIMIT_INVALID'],
    [['--currency', 'RUPEES'], 'CLI_BILLING_CURRENCY_INVALID'],
    [['--from', 'last week'], 'CLI_BILLING_DATE_INVALID'],
    [['--all', '--max', '0'], 'CLI_BILLING_MAX_INVALID'],
    [['--include', 'emails'], 'CLI_BILLING_INCLUDE_INVALID'],
  ])('billing log %j is refused before any request', async (flags, code) => {
    stub.reset();
    const r = await runCli(['billing', 'log', '--app', 'app_1', ...flags, '--json'], env);
    expect(r.code).toBe(1);
    const { error } = JSON.parse(r.stderr) as { error: { code: string; fix: string } };
    expect(error.code).toBe(code);
    expect(error.fix).toBeTruthy();
    expect(stub.requests).toEqual([]);
  });

  it('billing log without --app is a usage error, and an API refusal passes through', async () => {
    stub.reset();
    const usage = await runCli(['billing', 'log', '--json'], env);
    expect(usage.code).toBe(1);
    expect((JSON.parse(usage.stderr) as { error: { code: string } }).error.code).toBe('CLI_USAGE_ERROR');

    const error = { code: 'VALIDATION_ERROR', message: 'unknown event type', fix: 'Use a type the log has.' };
    stub.error(`GET ${APP}/billing/events?type=nope`, 400, error);
    const refused = await runCli(['billing', 'log', '--app', 'app_1', '--type', 'nope', '--json'], env);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stderr)).toEqual({ success: false, error });
  });

  // ---------- billing preview ----------

  const PREVIEW = valid('RoutingPreviewDtoSchema', {
    country: 'IN',
    countrySource: 'declared',
    localPrices: 'trusted',
    onUnavailableCurrency: 'fallback',
    items: [
      {
        plan: { id: 'plan_pro', slug: 'pro', name: 'Pro', kind: 'SUBSCRIPTION' },
        price: { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00', isDefault: true, reason: 'fallback', requestedCurrency: 'INR' },
        priceFallback: {
          requested: { id: 'pp_inr', currency: 'INR', amount: 149900, formatted: '₹1,499.00' },
          charged: { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00' },
          reason: 'no_provider_for_currency',
        },
        provider: 'stripe',
        providerReason: 'only_capable',
        refusal: null,
        coupon: {
          code: 'launch',
          discount: { currency: 'USD', discountAmount: 285, amountAfterDiscount: 1615, formatted: { discount: '$2.85', total: '$16.15' } },
          refusal: null,
        },
        summary: 'A buyer in India buying Pro pays $19.00 through Stripe.',
      },
      {
        plan: { id: 'plan_yen', slug: 'yen', name: 'Yen', kind: 'SUBSCRIPTION' },
        price: { id: 'pp_jpy', currency: 'JPY', amount: 5000, formatted: '¥5,000', isDefault: true, reason: 'default', requestedCurrency: null },
        priceFallback: null,
        provider: 'stripe',
        providerReason: 'priority',
        refusal: null,
        coupon: {
          code: 'launch',
          discount: null,
          refusal: { code: 'COUPON_CURRENCY_NOT_COVERED', message: 'This code does not work for prices in JPY.', fix: null },
        },
        summary: 'A buyer in India buying Yen pays ¥5,000 through Stripe.',
      },
      {
        plan: { id: 'plan_team', slug: 'team', name: 'Team', kind: 'SUBSCRIPTION' },
        price: null,
        priceFallback: null,
        provider: null,
        providerReason: null,
        refusal: { code: 'BILLING_NO_PROVIDER_FOR_CURRENCY', message: 'No provider can charge EUR.', fix: 'Add EUR to a provider.' },
        coupon: null,
        summary: 'A buyer in India cannot buy Team.',
      },
    ],
  });

  it('billing preview posts every flag as the route names it', async () => {
    stub.reset();
    stub.ok(`POST ${APP}/billing/checkout/preview`, PREVIEW);
    const r = await runCli(
      [
        'billing', 'preview', '--app', 'app_1', '--country', 'in', '--plan', 'pro', '--coupon', 'LAUNCH',
        '--country-source', 'declared', '--currency', 'inr', '--provider', 'stripe', '--end-user', 'eu_1',
        '--on-unavailable-currency', 'fallback', '--json',
      ],
      env,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests).toEqual([
      {
        key: `POST ${APP}/billing/checkout/preview`,
        auth: AUTH,
        body: valid('RoutingPreviewRequestSchema', {
          country: 'IN',
          plan: 'pro',
          countrySource: 'declared',
          endUserId: 'eu_1',
          currency: 'INR',
          onUnavailableCurrency: 'fallback',
          provider: 'stripe',
          couponCode: 'LAUNCH',
        }),
      },
    ]);
    expect(JSON.parse(r.stdout)).toEqual(PREVIEW);
  });

  it('billing preview prints the summary, the fallback sentence, and the coupon discount or refusal', async () => {
    stub.reset();
    stub.ok(`POST ${APP}/billing/checkout/preview`, PREVIEW);
    const r = await runCli(['billing', 'preview', '--app', 'app_1', '--country', 'IN'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests.map((q) => q.body)).toEqual([{ country: 'IN' }]);
    expect(r.stdout).toBe(
      [
        'pro: A buyer in India buying Pro pays $19.00 through Stripe.',
        '    Prices in INR are not available yet. You will pay $19.00.',
        '    coupon launch: $2.85 off, $16.15 to pay',
        'yen: A buyer in India buying Yen pays ¥5,000 through Stripe.',
        '    coupon launch refused: COUPON_CURRENCY_NOT_COVERED: This code does not work for prices in JPY.',
        'team: A buyer in India cannot buy Team.',
        '    refused: BILLING_NO_PROVIDER_FOR_CURRENCY: No provider can charge EUR.',
        '    fix: Add EUR to a provider.',
        '',
      ].join('\n'),
    );
  });

  it('billing preview says which rule a named currency got, and whose rule it was', async () => {
    stub.reset();
    stub.ok(`POST ${APP}/billing/checkout/preview`, { ...PREVIEW, onUnavailableCurrency: 'refuse' });
    const byDefault = await runCli(['billing', 'preview', '--app', 'app_1', '--country', 'IN', '--country-source', 'declared', '--currency', 'INR'], env);
    expect(byDefault.code, byDefault.stderr).toBe(0);
    expect(byDefault.stdout.split('\n')[0]).toBe('a named currency that cannot be charged is refused (the Application default)');

    stub.ok(`POST ${APP}/billing/checkout/preview`, PREVIEW);
    const sent = await runCli(
      ['billing', 'preview', '--app', 'app_1', '--country', 'IN', '--country-source', 'declared', '--currency', 'INR', '--on-unavailable-currency', 'fallback'],
      env,
    );
    expect(sent.stdout.split('\n')[0]).toBe('a named currency that cannot be charged is charged the default price (--on-unavailable-currency)');
  });

  it.each([
    [['--country', 'IND'], 'CLI_BILLING_COUNTRY_INVALID'],
    [['--country', 'IN', '--country-source', 'guess'], 'CLI_BILLING_COUNTRY_SOURCE_INVALID'],
    [['--country', 'IN', '--currency', 'RUPEE'], 'CLI_BILLING_CURRENCY_INVALID'],
    [['--country', 'IN', '--on-unavailable-currency', 'ignore'], 'CLI_BILLING_ON_UNAVAILABLE_INVALID'],
  ])('billing preview %j is refused before any request', async (flags, code) => {
    stub.reset();
    const r = await runCli(['billing', 'preview', '--app', 'app_1', ...flags, '--json'], env);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.stderr) as { error: { code: string } }).error.code).toBe(code);
    expect(stub.requests).toEqual([]);
  });

  it('billing preview without --country is a usage error, and PLAN_NOT_FOUND passes through', async () => {
    stub.reset();
    const usage = await runCli(['billing', 'preview', '--app', 'app_1', '--json'], env);
    expect((JSON.parse(usage.stderr) as { error: { code: string } }).error.code).toBe('CLI_USAGE_ERROR');
    const error = { code: 'PLAN_NOT_FOUND', message: 'no such plan', fix: 'List the plans.' };
    stub.error(`POST ${APP}/billing/checkout/preview`, 404, error);
    const r = await runCli(['billing', 'preview', '--app', 'app_1', '--country', 'IN', '--plan', 'nope', '--json'], env);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({ success: false, error });
  });

  // ---------- billing reporting-currency ----------

  it('billing reporting-currency get reads it', async () => {
    stub.reset();
    const dto = valid('ReportingCurrencyDtoSchema', { reportingCurrency: 'USD', name: 'US Dollar' });
    stub.ok(`GET ${APP}/billing/reporting-currency`, dto);
    const text = await runCli(['billing', 'reporting-currency', 'get', '--app', 'app_1'], env);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toBe('USD  US Dollar\n');
    const json = await runCli(['billing', 'reporting-currency', 'get', '--app', 'app_1', '--json'], env);
    expect(JSON.parse(json.stdout)).toEqual(dto);
    expect(stub.requests[0]).toEqual({ key: `GET ${APP}/billing/reporting-currency`, body: undefined, auth: AUTH });
  });

  it('billing reporting-currency set puts the code upper-cased', async () => {
    stub.reset();
    const dto = { reportingCurrency: 'JPY', name: 'Yen' };
    stub.ok(`PUT ${APP}/billing/reporting-currency`, dto);
    const json = await runCli(['billing', 'reporting-currency', 'set', 'jpy', '--app', 'app_1', '--json'], env);
    expect(json.code, json.stderr).toBe(0);
    expect(stub.requests).toEqual([
      { key: `PUT ${APP}/billing/reporting-currency`, body: valid('SetReportingCurrencyRequestSchema', { reportingCurrency: 'JPY' }), auth: AUTH },
    ]);
    expect(JSON.parse(json.stdout)).toEqual(dto);
    const text = await runCli(['billing', 'reporting-currency', 'set', 'JPY', '--app', 'app_1'], env);
    expect(text.stdout).toBe('✓ reporting in JPY  Yen\n');
  });

  it('billing reporting-currency set refuses a malformed code, needs one, and passes the API refusal through', async () => {
    stub.reset();
    const malformed = await runCli(['billing', 'reporting-currency', 'set', 'EURO', '--app', 'app_1', '--json'], env);
    expect((JSON.parse(malformed.stderr) as { error: { code: string } }).error.code).toBe('CLI_BILLING_CURRENCY_INVALID');
    const missing = await runCli(['billing', 'reporting-currency', 'set', '--app', 'app_1', '--json'], env);
    expect((JSON.parse(missing.stderr) as { error: { code: string } }).error.code).toBe('CLI_USAGE_ERROR');
    expect(stub.requests).toEqual([]);

    const error = { code: 'BILLING_REPORTING_CURRENCY_INVALID', message: 'KWD cannot be priced', fix: 'Pick a sellable currency.' };
    stub.error(`PUT ${APP}/billing/reporting-currency`, 400, error);
    const refused = await runCli(['billing', 'reporting-currency', 'set', 'KWD', '--app', 'app_1', '--json'], env);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stderr)).toEqual({ success: false, error });
  });

  // ---------- billing unavailable-currency ----------

  it('billing unavailable-currency get reads the default off the Application', async () => {
    stub.reset();
    const billingConfig = valid('BillingConfigSchema', { enabled: true, provider: 'stripe', onUnavailableCurrency: 'fallback' });
    stub.ok(`GET ${APP}`, { id: 'app_1', slug: 'shop', billingConfig });
    const text = await runCli(['billing', 'unavailable-currency', 'get', '--app', 'app_1'], env);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toBe('fallback  charges the default price of the plan\n');
    const json = await runCli(['billing', 'unavailable-currency', 'get', '--app', 'app_1', '--json'], env);
    expect(JSON.parse(json.stdout)).toEqual({ onUnavailableCurrency: 'fallback' });
    expect(stub.requests[0]).toEqual({ key: `GET ${APP}`, body: undefined, auth: AUTH });
  });

  // ---------- billing reconciliation ----------

  function report(over: Record<string, unknown> = {}) {
    return valid('ReconciliationReportSchema', {
      applicationId: 'app_1',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-08T00:00:00.000Z',
      paymentsLoggedSince: '2026-09-01T00:00:00.000Z',
      subscriptionsLoggedSince: '2026-09-01T00:00:00.000Z',
      checked: { payments: 12, refunds: 1, subscriptions: 4, events: 40 },
      counts: { payment_without_event: 0, event_without_payment: 0, refund_mismatch: 0, subscription_without_event: 0 },
      findings: [],
      truncated: false,
      ...over,
    });
  }

  it('billing reconciliation prints the findings with their money, and sends the period', async () => {
    stub.reset();
    const found = report({
      counts: { payment_without_event: 1, event_without_payment: 0, refund_mismatch: 0, subscription_without_event: 0 },
      findings: [
        {
          kind: 'payment_without_event',
          paymentId: 'pay_9',
          subscriptionId: null,
          eventSeq: null,
          currency: 'JPY',
          amount: 5000,
          refundedOnPayment: null,
          refundRowsTotal: null,
          refundEventsTotal: null,
          at: '2026-10-03T00:00:00.000Z',
        },
      ],
    });
    const key = `GET ${APP}/billing/reconciliation?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-08T00%3A00%3A00.000Z`;
    stub.ok(key, found);
    const args = ['billing', 'reconciliation', '--app', 'app_1', '--from', '2026-10-01', '--to', '2026-10-08'];
    const text = await runCli(args, env);
    expect(text.code, text.stderr).toBe(0);
    expect(stub.requests).toEqual([{ key, body: undefined, auth: AUTH }]);
    expect(text.stdout).toBe(
      [
        '2026-10-01T00:00:00.000Z to 2026-10-08T00:00:00.000Z',
        'checked 12 payments, 1 refunds, 4 subscriptions, 40 log entries',
        '✗ payment_without_event: 1',
        '    2026-10-03T00:00:00.000Z  payment_without_event  ¥5,000  payment=pay_9',
        '',
      ].join('\n'),
    );
    const json = await runCli([...args, '--json'], env);
    expect(JSON.parse(json.stdout)).toEqual(found);
  });

  it('billing reconciliation says so when the log and the records agree', async () => {
    stub.reset();
    stub.ok(`GET ${APP}/billing/reconciliation`, report());
    const r = await runCli(['billing', 'reconciliation', '--app', 'app_1'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('✓ the log and the records agree\n');
  });

  it('billing reconciliation refuses a bad date and passes the API refusal through', async () => {
    stub.reset();
    const bad = await runCli(['billing', 'reconciliation', '--app', 'app_1', '--from', 'monday', '--json'], env);
    expect((JSON.parse(bad.stderr) as { error: { code: string } }).error.code).toBe('CLI_BILLING_DATE_INVALID');
    expect(stub.requests).toEqual([]);
    const error = { code: 'BILLING_LOG_PERIOD_INVALID', message: 'more than 31 days', fix: 'Shorten the period.' };
    stub.error(`GET ${APP}/billing/reconciliation`, 400, error);
    const refused = await runCli(['billing', 'reconciliation', '--app', 'app_1', '--json'], env);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stderr)).toEqual({ success: false, error });
  });

  // ---------- billing price-fallbacks ----------

  it('billing price-fallbacks prints each group', async () => {
    stub.reset();
    const summary = valid('PriceFallbackSummarySchema', {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-08T00:00:00.000Z',
      total: 12,
      groups: [
        { planSlug: 'pro', requestedCurrency: 'INR', chargedCurrency: 'USD', country: 'IN', count: 12, lastOccurredAt: '2026-10-07T00:00:00.000Z' },
      ],
    });
    stub.ok(`GET ${APP}/billing/price-fallbacks`, summary);
    const text = await runCli(['billing', 'price-fallbacks', '--app', 'app_1'], env);
    expect(text.code, text.stderr).toBe(0);
    expect(stub.requests).toEqual([{ key: `GET ${APP}/billing/price-fallbacks`, body: undefined, auth: AUTH }]);
    expect(text.stdout).toBe(
      [
        '2026-10-01T00:00:00.000Z to 2026-10-08T00:00:00.000Z',
        '12 checkouts charged the default price because their currency could not be charged',
        '       12  pro  INR -> USD  IN  last 2026-10-07T00:00:00.000Z',
        '',
      ].join('\n'),
    );
    const json = await runCli(['billing', 'price-fallbacks', '--app', 'app_1', '--json'], env);
    expect(JSON.parse(json.stdout)).toEqual(summary);
  });

  it('billing price-fallbacks sends the period, and passes an API refusal through', async () => {
    stub.reset();
    const error = { code: 'SCOPE_INSUFFICIENT', message: "This action requires the 'billing:read' scope.", fix: 'Mint a token with billing:read.' };
    const key = `GET ${APP}/billing/price-fallbacks?from=2026-10-01T00%3A00%3A00.000Z`;
    stub.error(key, 403, error);
    const r = await runCli(['billing', 'price-fallbacks', '--app', 'app_1', '--from', '2026-10-01', '--json'], env);
    expect(r.code).toBe(1);
    expect(stub.requests.map((q) => q.key)).toEqual([key]);
    expect(JSON.parse(r.stderr)).toEqual({ success: false, error });
  });
});
