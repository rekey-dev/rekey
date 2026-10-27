/**
 * `rekey doctor`: each money check trips on a fixture that should trip it and
 * passes on a clean one, with the exit code that follows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_KEY,
  OPERATOR_TOKEN,
  coupon,
  credential,
  paged,
  plan,
  price,
  runCli,
  startStubServer,
  valid,
  type StubServer,
} from './helpers.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  message: string;
  fix?: string;
  applicationId?: string;
}

const APPS = 'GET /api/v1/tenant/applications?limit=100&offset=0';
const OUTBOX = 'GET /api/v1/admin/metrics/billing-outbox';
const MONEY_CHECKS = [
  'plan-currencies',
  'provider-currencies',
  'price-providers',
  'coupon-coverage',
  'unapplied-payments',
  'unpriced-subscriptions',
  'reconciliation',
];

const INR = price({ id: 'pp_inr', currency: 'INR', amount: 149900, isDefault: false });
const PRO = plan({ prices: [price(), INR] });
const STRIPE = credential({ currencies: ['USD', 'INR'] });

function report(counts: Record<string, number> = {}) {
  return valid('ReconciliationReportSchema', {
    applicationId: 'app_1',
    from: '2026-10-04T00:00:00.000Z',
    to: '2026-10-11T00:00:00.000Z',
    paymentsLoggedSince: '2026-09-01T00:00:00.000Z',
    subscriptionsLoggedSince: '2026-09-01T00:00:00.000Z',
    checked: { payments: 12, refunds: 1, subscriptions: 4, events: 40 },
    counts: { payment_without_event: 0, event_without_payment: 0, refund_mismatch: 0, subscription_without_event: 0, ...counts },
    findings: [],
    truncated: false,
  });
}

function stats(unpricedLiveSubscriptions = 0) {
  return valid('BillingStatsDtoSchema', {
    activeSubscriptions: 4,
    pastDueSubscriptions: 0,
    canceledLast30d: 0,
    newSubscriptionsLast30d: 1,
    unpricedLiveSubscriptions,
    reportingCurrency: 'USD',
    mrr: [{ currency: 'USD', mrrCents: 5700, activeSubscriptions: 3 }],
    revenueLast30d: [{ currency: 'USD', grossCents: 0, refundedCents: 0, netCents: 0, payments: 0 }],
    unverified: [],
    paymentsLast30d: { succeeded: 0, failed: 0 },
    monthlyRevenue: [],
  });
}

function outbox(over: Record<string, unknown> = {}) {
  return valid('BillingOutboxStatusSchema', { pending: 0, due: 0, failing: 0, failingThreshold: 5, oldestPendingAt: null, stuck: [], ...over });
}

/** A row of `GET …/unapplied-payments`, a copy of what `toRow` in the API's unapplied-payments service returns. */
function unapplied(over: Record<string, unknown> = {}) {
  return {
    id: 'up_1',
    paymentId: 'pay_1',
    provider: 'stripe',
    amount: 1900,
    currency: 'USD',
    refundedAmount: 0,
    status: 'OPEN',
    endUserId: null,
    endUserEmail: null,
    providerPaymentId: 'in_1',
    providerRefundId: null,
    resolutionNote: null,
    resolvedBy: null,
    resolvedAt: null,
    openedAt: '2026-10-01T09:00:00.000Z',
    ageDays: 10,
    refundable: true,
    ...over,
  };
}

describe('rekey doctor', () => {
  let stub: StubServer;
  let operator: Record<string, string>;
  let both: Record<string, string>;

  beforeAll(async () => {
    stub = await startStubServer();
    operator = { REKEY_URL: stub.url, REKEY_OPERATOR_TOKEN: OPERATOR_TOKEN };
    both = { ...operator, SUPER_ADMIN_KEY: ADMIN_KEY };
  });

  afterAll(async () => {
    await stub.close();
  });

  const app = (id: string) => `/api/v1/tenant/applications/${id}`;

  /** Answers under which every check of `id` passes. A test then replaces the one answer it is about. */
  function cleanApplication(id: string): void {
    stub.ok(`GET ${app(id)}/plans?limit=100&offset=0`, paged([PRO], 100));
    stub.ok(`GET ${app(id)}/billing-credentials`, [STRIPE]);
    stub.ok(`GET ${app(id)}/coupons?limit=100&offset=0`, paged([coupon()], 100));
    stub.ok(`GET ${app(id)}/unapplied-payments?status=OPEN&limit=100&offset=0`, paged([], 100));
    stub.ok(`GET ${app(id)}/billing/stats`, stats());
    stub.ok(`GET ${app(id)}/billing/reconciliation`, report());
  }

  beforeEach(() => {
    stub.reset();
    stub.ok('GET /health', { status: 'ok' });
    // Only `id` is read. The rest is a partial copy of an Application row.
    stub.ok(APPS, paged([{ id: 'app_1', tenantId: 'tn_1', name: 'A', slug: 'a', publicKey: 'rp_pub_a' }], 100));
    stub.ok(OUTBOX, outbox());
    cleanApplication('app_1');
  });

  async function doctor(env: Record<string, string>, args: string[] = []) {
    const r = await runCli(['doctor', ...args, '--json'], env);
    const { checks } = JSON.parse(r.stdout) as { checks: Check[] };
    const named = (name: string, applicationId = 'app_1') =>
      checks.find((check) => check.name === name && (check.applicationId ?? 'app_1') === applicationId)!;
    return { code: r.code, checks, named };
  }

  // ---------- the clean run, and its shape ----------

  it('a clean deployment passes every money check and exits 0', async () => {
    const { code, checks } = await doctor(both);
    expect(code).toBe(0);
    expect(checks.map((check) => [check.name, check.status, check.applicationId])).toEqual([
      ['api-url', 'ok', undefined],
      ['admin-key', 'ok', undefined],
      ['health', 'ok', undefined],
      ['applications', 'ok', undefined],
      ['plan-currencies', 'ok', 'app_1'],
      ['provider-currencies', 'ok', 'app_1'],
      ['price-providers', 'ok', 'app_1'],
      ['coupon-coverage', 'ok', 'app_1'],
      ['unapplied-payments', 'ok', 'app_1'],
      ['unpriced-subscriptions', 'ok', 'app_1'],
      ['reconciliation', 'ok', 'app_1'],
      ['billing-outbox', 'ok', undefined],
    ]);
    for (const check of checks) {
      expect(typeof check.message).toBe('string');
      if (check.status !== 'ok') expect(check.fix).toBeTruthy();
    }
  });

  it('reads with the operator token, the outbox with the admin key, and sends only GETs', async () => {
    await doctor(both);
    expect(stub.requests.every((q) => q.key.startsWith('GET '))).toBe(true);
    const auth = Object.fromEntries(stub.requests.map((q) => [q.key, q.auth]));
    expect(auth[OUTBOX]).toBe(`Bearer ${ADMIN_KEY}`);
    expect(auth[`GET ${app('app_1')}/plans?limit=100&offset=0`]).toBe(`Bearer ${OPERATOR_TOKEN}`);
    expect(auth[`GET ${app('app_1')}/billing/reconciliation`]).toBe(`Bearer ${OPERATOR_TOKEN}`);
  });

  it('checks every Application the token sees, across pages, or only --app', async () => {
    stub.ok(APPS, paged([{ id: 'app_1' }], 100, 0, 101));
    stub.ok('GET /api/v1/tenant/applications?limit=100&offset=100', paged([{ id: 'app_2' }], 100, 100, 101));
    cleanApplication('app_2');
    const all = await doctor(operator);
    expect(all.code).toBe(0);
    expect(all.checks.filter((check) => check.name === 'reconciliation').map((check) => check.applicationId)).toEqual(['app_1', 'app_2']);

    stub.requests.length = 0;
    const one = await doctor(operator, ['--app', 'app_2']);
    expect(one.checks.filter((check) => check.applicationId !== undefined).every((check) => check.applicationId === 'app_2')).toBe(true);
    expect(one.checks.some((check) => check.name === 'applications')).toBe(false);
    expect(stub.requests.some((q) => q.key.startsWith('GET /api/v1/tenant/applications?'))).toBe(false);
  });

  it('prints each check as text, with the Application and the fix', async () => {
    stub.ok(`GET ${app('app_1')}/billing-credentials`, [credential({ currencies: ['USD', 'INR', 'KWD'], unsupportedCurrencies: ['KWD'] })]);
    const r = await runCli(['doctor'], operator);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('✓ plan-currencies [app_1] 1 active plan, every price in a sellable currency\n');
    expect(r.stdout).toContain('✗ provider-currencies [app_1] A provider stores currencies it cannot charge: stripe stores KWD\n  fix: Remove them');
    expect(r.stdout).toContain('- billing-outbox not checked: it needs the super-admin key\n  fix: Set SUPER_ADMIN_KEY');
  });

  // ---------- skipped ----------

  it('without an operator token every money check is skipped, naming the token and the scope, and the run exits 0', async () => {
    const { code, checks } = await doctor({ REKEY_URL: stub.url, SUPER_ADMIN_KEY: ADMIN_KEY });
    expect(code).toBe(0);
    for (const name of MONEY_CHECKS) {
      const check = checks.find((each) => each.name === name)!;
      expect(check.status).toBe('skipped');
      expect(check.fix).toContain('REKEY_OPERATOR_TOKEN');
      expect(check.fix).toContain('with the read scope');
    }
    expect(checks.find((check) => check.name === 'billing-outbox')?.status).toBe('ok');
    expect(stub.requests.map((q) => q.key).sort()).toEqual(['GET /health', OUTBOX].sort());
  });

  it('without the admin key the outbox check is skipped, not ok', async () => {
    const { code, checks } = await doctor(operator);
    expect(code).toBe(0);
    const check = checks.find((each) => each.name === 'billing-outbox')!;
    expect(check.status).toBe('skipped');
    expect(check.fix).toContain('SUPER_ADMIN_KEY');
    expect(stub.requests.some((q) => q.key === OUTBOX)).toBe(false);
  });

  it('a token that may not read billing leaves that check skipped, and another API error fails it', async () => {
    stub.error(`GET ${app('app_1')}/coupons?limit=100&offset=0`, 403, { code: 'SCOPE_INSUFFICIENT', message: "This action requires the 'billing:read' scope." });
    stub.error(`GET ${app('app_1')}/billing/reconciliation`, 503, { code: 'ANALYTICS_TIMEOUT', message: 'too slow', fix: 'Retry with a shorter period.' });
    const { code, named } = await doctor(operator);
    expect(code).toBe(1);
    expect(named('coupon-coverage')).toMatchObject({ status: 'skipped', message: expect.stringContaining('SCOPE_INSUFFICIENT') });
    expect(named('coupon-coverage').fix).toContain('with the read scope');
    expect(named('reconciliation')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('ANALYTICS_TIMEOUT'),
      fix: 'Retry with a shorter period.',
    });
    expect(named('plan-currencies').status).toBe('ok');
  });

  it('a token the API rejects fails the applications check', async () => {
    stub.error(APPS, 401, { code: 'TENANT_SESSION_INVALID', message: 'the token is invalid', fix: 'Mint a new token.' });
    const { code, checks } = await doctor(operator);
    expect(code).toBe(1);
    expect(checks.find((check) => check.name === 'applications')).toMatchObject({ status: 'fail', fix: 'Mint a new token.' });
  });

  it('with no API URL, or an API that does not answer /health, the money checks are skipped', async () => {
    const noUrl = await runCli(['doctor', '--json'], { REKEY_OPERATOR_TOKEN: OPERATOR_TOKEN });
    const first = (JSON.parse(noUrl.stdout) as { checks: Check[] }).checks;
    expect(noUrl.code).toBe(1);
    expect(first.find((check) => check.name === 'reconciliation')?.status).toBe('skipped');

    stub.error('GET /health', 503, { code: 'DOWN', message: 'down' });
    const down = await doctor(both);
    expect(down.code).toBe(1);
    expect(down.checks.find((check) => check.name === 'billing-outbox')?.status).toBe('skipped');
    expect(stub.requests.map((q) => q.key)).toEqual(['GET /health']);
  });

  // ---------- plan-currencies ----------

  it('plan-currencies fails on an unsellable currency and a malformed amount, naming each plan', async () => {
    const kwd = plan({ id: 'p2', slug: 'gulf', prices: [price({ id: 'pp_kwd', currency: 'KWD', amount: 1000 })] });
    const huf = plan({ id: 'p3', slug: 'forint', prices: [price({ id: 'pp_huf', currency: 'HUF', amount: 500050 })] });
    const retired = plan({ id: 'p5', slug: 'retired', active: false, prices: [price({ id: 'pp_bhd', currency: 'BHD', amount: 1000 })] });
    stub.ok(`GET ${app('app_1')}/plans?limit=100&offset=0`, paged([PRO, kwd, huf, retired], 100));
    stub.ok(`GET ${app('app_1')}/billing-credentials`, [credential({ currencies: ['USD', 'INR', 'HUF', 'KWD'] })]);
    const { code, named } = await doctor(operator);
    expect(code).toBe(1);
    const check = named('plan-currencies');
    expect(check.status).toBe('fail');
    expect(check.message).toContain('gulf: KWD is not a currency a price can be in');
    // Intl puts a no-break space between the code and the number.
    expect(check.message).toMatch(/forint: HUF\s5,000\.50 \(HUF is priced in whole units/);
    expect(check.message).not.toContain('retired');
    expect(check.fix).toContain('rekey plans prices archive <plan> <currency> --app app_1');
    expect(check.fix).toContain('{"price": {"currency": "USD", "amount": 1900}}');
  });

  // ---------- provider-currencies ----------

  it('provider-currencies fails when a provider stores a currency it cannot charge', async () => {
    stub.ok(`GET ${app('app_1')}/billing-credentials`, [
      credential({ currencies: ['USD', 'INR'] }),
      credential({ provider: 'razorpay', currencies: ['INR', 'KWD', 'BHD'], unsupportedCurrencies: ['BHD', 'KWD'] }),
    ]);
    const { code, named } = await doctor(operator);
    expect(code).toBe(1);
    expect(named('provider-currencies')).toMatchObject({
      status: 'fail',
      message: 'A provider stores currencies it cannot charge: razorpay stores BHD, KWD',
    });
    expect(named('provider-currencies').fix).toBeTruthy();
  });

  it('provider-currencies warns on an enabled provider with no currency: an empty list means none', async () => {
    stub.ok(`GET ${app('app_1')}/billing-credentials`, [
      credential({ currencies: ['USD', 'INR'] }),
      credential({ provider: 'paypal', currencies: [] }),
      credential({ provider: 'razorpay', currencies: [], enabled: false }),
    ]);
    const { code, named } = await doctor(operator);
    expect(code).toBe(0);
    expect(named('provider-currencies')).toMatchObject({
      status: 'warn',
      message: 'Enabled with no currency, so not used for any checkout: paypal',
    });
    expect(named('provider-currencies').fix).toContain('Tick the currencies the account charges');
  });

  it('price-providers reads an enabled provider with no currency as charging nothing', async () => {
    stub.ok(`GET ${app('app_1')}/billing-credentials`, [credential({ currencies: [] })]);
    const { code, named } = await doctor(operator);
    expect(code).toBe(1);
    expect(named('price-providers')).toMatchObject({ status: 'fail', message: expect.stringContaining('default prices: pro USD') });
  });

  // ---------- price-providers ----------

  it('price-providers warns on an additional price nobody can charge, and exits 0', async () => {
    stub.ok(`GET ${app('app_1')}/billing-credentials`, [credential({ currencies: ['USD'] })]);
    const { code, named } = await doctor(operator);
    expect(code).toBe(0);
    const check = named('price-providers');
    expect(check.status).toBe('warn');
    expect(check.message).toContain('additional prices, whose buyers pay the default price instead: pro INR');
    expect(check.fix).toContain('rekey billing preview --app app_1');
  });

  it('price-providers fails on a default price nobody can charge', async () => {
    stub.ok(`GET ${app('app_1')}/billing-credentials`, [credential({ currencies: ['INR'] })]);
    const { code, named } = await doctor(operator);
    expect(code).toBe(1);
    expect(named('price-providers')).toMatchObject({ status: 'fail', message: 'No enabled provider can charge default prices: pro USD' });
  });

  it('price-providers does not count a disabled provider, or a currency the provider stores but cannot charge', async () => {
    stub.ok(`GET ${app('app_1')}/billing-credentials`, [
      credential({ currencies: ['USD'], enabled: false }),
      credential({ provider: 'paypal', currencies: ['INR', 'USD'], unsupportedCurrencies: ['USD'] }),
    ]);
    const { named } = await doctor(operator);
    expect(named('price-providers')).toMatchObject({ status: 'fail', message: 'No enabled provider can charge default prices: pro USD' });
  });

  it('price-providers says so when no provider is enabled, and surfaces the API blocker for a plan it did not catch', async () => {
    stub.ok(`GET ${app('app_1')}/billing-credentials`, []);
    const none = await doctor(operator);
    expect(none.named('price-providers').message).toContain('No billing provider is enabled.');

    const blocked = plan({
      checkout: { ready: false, blockers: [{ provider: null, code: 'PLAN_CURRENCY_UNSUPPORTED', message: 'No enabled provider is set up to charge USD', fix: 'Add USD.' }] },
    });
    stub.ok(`GET ${app('app_1')}/plans?limit=100&offset=0`, paged([blocked], 100));
    stub.ok(`GET ${app('app_1')}/billing-credentials`, [credential({ currencies: ['USD'] })]);
    const api = await doctor(operator);
    expect(api.code).toBe(1);
    expect(api.named('price-providers')).toMatchObject({ status: 'fail', message: expect.stringContaining('pro: PLAN_CURRENCY_UNSUPPORTED') });
  });

  // ---------- coupon-coverage ----------

  const EUR_ONLY = {
    code: 'euro',
    discountType: 'AMOUNT',
    basisPoints: null,
    amounts: [{ currency: 'EUR', amountOff: 500 }],
    coveredCurrencies: ['EUR'],
  };

  it('coupon-coverage fails on an active coupon that covers none of its plans currencies', async () => {
    stub.ok(`GET ${app('app_1')}/coupons?limit=100&offset=0`, paged([coupon(), coupon({ ...EUR_ONLY, planSlugs: ['pro'] })], 100));
    const { code, named } = await doctor(operator);
    expect(code).toBe(1);
    expect(named('coupon-coverage')).toMatchObject({
      status: 'fail',
      message: '1 active coupon can never be redeemed: euro covers EUR, but its plans (pro) are priced in INR, USD',
    });
    expect(named('coupon-coverage').fix).toContain('rekey coupons update <code> --app app_1 --amount CUR=n');
  });

  it('coupon-coverage judges a coupon for every plan against every active plan', async () => {
    stub.ok(`GET ${app('app_1')}/coupons?limit=100&offset=0`, paged([coupon(EUR_ONLY)], 100));
    const { named } = await doctor(operator);
    expect(named('coupon-coverage').message).toContain('euro covers EUR, but the plans are priced in INR, USD');
  });

  it('coupon-coverage ignores an inactive coupon, an ended one, and one that covers a currency of its plans', async () => {
    stub.ok(
      `GET ${app('app_1')}/coupons?limit=100&offset=0`,
      paged(
        [
          coupon({ ...EUR_ONLY, active: false }),
          coupon({ ...EUR_ONLY, code: 'ended', endsAt: '2020-01-01T00:00:00.000Z' }),
          coupon({ ...EUR_ONLY, code: 'rupee', amounts: [{ currency: 'INR', amountOff: 40000 }], coveredCurrencies: ['INR'] }),
        ],
        100,
      ),
    );
    const { code, named } = await doctor(operator);
    expect(code).toBe(0);
    expect(named('coupon-coverage')).toMatchObject({ status: 'ok', message: '1 active coupon, each covering a currency its plans are priced in' });
  });

  // ---------- unapplied-payments ----------

  it('unapplied-payments warns with the count and the money per currency, and exits 0', async () => {
    const rows = [unapplied(), unapplied({ id: 'up_2', amount: 3800, refundedAmount: 800 }), unapplied({ id: 'up_3', amount: 5000, currency: 'JPY' })];
    stub.ok(`GET ${app('app_1')}/unapplied-payments?status=OPEN&limit=100&offset=0`, paged(rows, 100));
    const { code, named } = await doctor(operator);
    expect(code).toBe(0);
    expect(named('unapplied-payments')).toMatchObject({
      status: 'warn',
      message: '3 open unapplied payments, net of refunds: ¥5,000 (1), $49.00 (2)',
    });
    expect(named('unapplied-payments').fix).toContain('/api/v1/tenant/applications/app_1/unapplied-payments?status=OPEN');
  });

  // ---------- reconciliation ----------

  it('reconciliation fails when the log and the records disagree', async () => {
    stub.ok(`GET ${app('app_1')}/billing/reconciliation`, report({ payment_without_event: 2, refund_mismatch: 1 }));
    const { code, named } = await doctor(operator);
    expect(code).toBe(1);
    expect(named('reconciliation')).toMatchObject({
      status: 'fail',
      message:
        'The billing log and the records disagree, 2026-10-04T00:00:00.000Z to 2026-10-11T00:00:00.000Z: 2 payment_without_event, 1 refund_mismatch',
    });
    expect(named('reconciliation').fix).toContain('rekey billing reconciliation --app app_1');
  });

  // ---------- billing-outbox ----------

  it('billing-outbox fails on stuck rows, naming the Applications they belong to', async () => {
    const row = { id: 'ob_1', applicationId: 'app_1', type: 'coupon.redeemed', attempts: 7, lastError: 'boom', createdAt: '2026-10-01T09:00:00.000Z', nextAttemptAt: '2026-10-11T09:00:00.000Z' };
    stub.ok(OUTBOX, outbox({ pending: 9, due: 2, failing: 3, oldestPendingAt: '2026-10-01T09:00:00.000Z', stuck: [row, { ...row, id: 'ob_2' }, { ...row, id: 'ob_3', applicationId: 'app_9' }] }));
    const { code, checks } = await doctor(both);
    expect(code).toBe(1);
    const check = checks.find((each) => each.name === 'billing-outbox')!;
    expect(check.status).toBe('fail');
    expect(check.message).toBe(
      '3 billing events failed 5 times or more and are missing from the billing log: app_1 (2), app_9 (1). Oldest waiting since 2026-10-01T09:00:00.000Z',
    );
    expect(check.fix).toContain('/api/v1/admin/metrics/billing-outbox');
  });

  it('billing-outbox fails when the admin key is refused', async () => {
    stub.error(OUTBOX, 401, { code: 'ADMIN_AUTH_INVALID', message: 'wrong key', fix: 'Verify SUPER_ADMIN_KEY.' });
    const { code, checks } = await doctor(both);
    expect(code).toBe(1);
    expect(checks.find((each) => each.name === 'billing-outbox')).toMatchObject({ status: 'fail', fix: 'Verify SUPER_ADMIN_KEY.' });
  });

  // ---------- unpriced-subscriptions ----------

  it('unpriced-subscriptions passes at zero, read from the billing stats with the operator token', async () => {
    const { code, named } = await doctor(operator);
    expect(code).toBe(0);
    expect(named('unpriced-subscriptions')).toMatchObject({
      status: 'ok',
      message: 'every live subscription on a plan that has a price records its own price',
    });
    const read = stub.requests.find((q) => q.key === `GET ${app('app_1')}/billing/stats`);
    expect(read?.auth).toBe(`Bearer ${OPERATOR_TOKEN}`);
  });

  it('unpriced-subscriptions warns with the count and a fix that names the grant route, per Application', async () => {
    stub.ok(APPS, paged([{ id: 'app_1' }, { id: 'app_2' }], 100));
    cleanApplication('app_2');
    stub.ok(`GET ${app('app_1')}/billing/stats`, stats(3));
    const { code, named } = await doctor(operator);
    expect(code).toBe(0);
    const check = named('unpriced-subscriptions');
    expect(check.status).toBe('warn');
    expect(check.message).toBe(
      "3 live subscriptions on a plan that has a price record no price of their own. Each shows no price and is not counted in MRR",
    );
    expect(check.fix).toContain('POST /api/v1/tenant/applications/app_1/end-users/<endUserId>/subscriptions with {"planSlug": "<slug>"}');
    expect(named('unpriced-subscriptions', 'app_2').status).toBe('ok');

    stub.ok(`GET ${app('app_1')}/billing/stats`, stats(1));
    const one = await doctor(operator);
    expect(one.named('unpriced-subscriptions').message).toBe(
      "1 live subscription on a plan that has a price records no price of its own. It shows no price and is not counted in MRR",
    );
  });

  it('unpriced-subscriptions is skipped when the token may not read the stats, and fails when they cannot be read', async () => {
    stub.error(`GET ${app('app_1')}/billing/stats`, 403, { code: 'APP_ACCESS_DENIED', message: 'No.' });
    const denied = await doctor(operator);
    expect(denied.named('unpriced-subscriptions').status).toBe('skipped');

    stub.error(`GET ${app('app_1')}/billing/stats`, 503, { code: 'ANALYTICS_TIMEOUT', message: 'Too slow.', fix: 'Retry in a minute.' });
    const failed = await doctor(operator);
    expect(failed.code).toBe(1);
    expect(failed.named('unpriced-subscriptions')).toMatchObject({ status: 'fail', fix: 'Retry in a minute.' });
  });
});
