/** `rekey coupons …`, through the compiled binary against the stub server. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR_TOKEN, coupon, paged, runCli, startStubServer, valid, type StubServer } from './helpers.js';

const COUPONS = '/api/v1/tenant/applications/app_1/coupons';
const AUTH = `Bearer ${OPERATOR_TOKEN}`;

const PERCENT = coupon();
const FIXED = coupon({
  id: 'cpn_2',
  code: 'fiveoff',
  discountType: 'AMOUNT',
  basisPoints: null,
  amounts: [
    { currency: 'INR', amountOff: 40000 },
    { currency: 'JPY', amountOff: 500 },
    { currency: 'USD', amountOff: 500 },
  ],
  coveredCurrencies: ['INR', 'JPY', 'USD'],
  planSlugs: ['pro', 'team'],
  active: false,
});

function withStats(base: ReturnType<typeof coupon>, over: Record<string, unknown>) {
  return valid('CouponWithStatsDtoSchema', { ...base, redemptionCount: 0, discountIssuedByCurrency: [], ...over });
}

describe('rekey coupons', () => {
  let stub: StubServer;
  let env: Record<string, string>;

  beforeAll(async () => {
    stub = await startStubServer();
    env = { REKEY_URL: stub.url, REKEY_OPERATOR_TOKEN: OPERATOR_TOKEN };
  });

  afterAll(async () => {
    await stub.close();
  });

  it('coupons need an operator token', async () => {
    stub.reset();
    const r = await runCli(['coupons', 'list', '--app', 'app_1', '--json'], { REKEY_URL: stub.url });
    expect(r.code).toBe(1);
    const { error } = JSON.parse(r.stderr) as { error: { code: string; fix: string } };
    expect(error.code).toBe('CLI_OPERATOR_TOKEN_MISSING');
    expect(error.fix).toContain('with the read scope');
    expect(stub.requests).toEqual([]);
  });

  // ---------- list ----------

  it('coupons list prints the discount, the coverage and what was issued, money formatted', async () => {
    stub.reset();
    const rows = [
      withStats(PERCENT, { redemptionCount: 1 }),
      withStats(FIXED, {
        redemptionCount: 3,
        discountIssuedByCurrency: [
          { currency: 'USD', amount: 1000, redemptions: 2 },
          { currency: 'JPY', amount: 500, redemptions: 1 },
        ],
      }),
    ];
    stub.ok(`GET ${COUPONS}`, paged(rows));
    const r = await runCli(['coupons', 'list', '--app', 'app_1'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests).toEqual([{ key: `GET ${COUPONS}`, body: undefined, auth: AUTH }]);
    expect(r.stdout).toBe(
      [
        'launch  15% off  any currency  any plan  active',
        '    1 redemption',
        'fiveoff  ₹400.00, ¥500, $5.00 off  INR,JPY,USD  plans: pro,team  inactive',
        '    3 redemptions: $10.00 (2), ¥500 (1)',
        '',
      ].join('\n'),
    );
  });

  it('coupons list --json is the API page under `coupons`, and forwards paging', async () => {
    stub.reset();
    const rows = [withStats(PERCENT, {})];
    stub.ok(`GET ${COUPONS}?limit=10&offset=20`, paged(rows, 10, 20, 21));
    const r = await runCli(['coupons', 'list', '--app', 'app_1', '--limit', '10', '--offset', '20', '--json'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ coupons: rows, page: { total: 21, limit: 10, offset: 20, hasMore: false } });
  });

  // ---------- show ----------

  it('coupons show prints one coupon and its limits', async () => {
    stub.reset();
    const limited = coupon({ basisPoints: 1250, currencies: ['USD'], coveredCurrencies: ['USD'], endsAt: '2026-12-01T00:00:00.000Z', maxRedemptions: 100 });
    stub.ok(`GET ${COUPONS}/LAUNCH`, limited);
    const r = await runCli(['coupons', 'show', 'LAUNCH', '--app', 'app_1'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      ['launch  12.5% off  USD  any plan  active', '    ends 2026-12-01T00:00:00.000Z', '    at most 100 redemptions', ''].join('\n'),
    );
    const json = await runCli(['coupons', 'show', 'LAUNCH', '--app', 'app_1', '--json'], env);
    expect(JSON.parse(json.stdout)).toEqual(limited);
  });

  it('coupons show passes COUPON_NOT_FOUND through', async () => {
    stub.reset();
    const error = { code: 'COUPON_NOT_FOUND', message: 'no such coupon', fix: 'List the coupons first.' };
    stub.error(`GET ${COUPONS}/nope`, 404, error);
    const r = await runCli(['coupons', 'show', 'nope', '--app', 'app_1', '--json'], env);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({ success: false, error });
  });

  // ---------- create ----------

  it('coupons create --percent sends basis points and every limit', async () => {
    stub.reset();
    stub.ok(`POST ${COUPONS}`, PERCENT, 201);
    const r = await runCli(
      [
        'coupons', 'create', '--app', 'app_1', '--code', 'LAUNCH', '--percent', '12.5',
        '--currencies', 'usd, eur', '--plans', 'pro,team', '--starts-at', '2026-11-01', '--ends-at', '2026-12-01T09:30:00+05:30',
        '--max-redemptions', '100', '--max-redemptions-per-user', '1', '--json',
      ],
      env,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests).toEqual([
      {
        key: `POST ${COUPONS}`,
        auth: AUTH,
        body: valid('CreateCouponRequestSchema', {
          code: 'LAUNCH',
          discountType: 'PERCENT',
          basisPoints: 1250,
          currencies: ['USD', 'EUR'],
          planSlugs: ['pro', 'team'],
          startsAt: '2026-11-01T00:00:00.000Z',
          endsAt: '2026-12-01T04:00:00.000Z',
          maxRedemptions: 100,
          maxRedemptionsPerUser: 1,
        }),
      },
    ]);
    expect(JSON.parse(r.stdout)).toEqual(PERCENT);
  });

  it('coupons create --basis-points sends it as given', async () => {
    stub.reset();
    stub.ok(`POST ${COUPONS}`, PERCENT, 201);
    const r = await runCli(['coupons', 'create', '--app', 'app_1', '--code', 'launch', '--basis-points', '1500'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests.map((q) => q.body)).toEqual([{ code: 'launch', discountType: 'PERCENT', basisPoints: 1500 }]);
    expect(r.stdout).toBe('✓ launch  15% off  any currency  any plan  active\n');
  });

  it('coupons create --amount sends one amount per currency and prints each formatted', async () => {
    stub.reset();
    stub.ok(`POST ${COUPONS}`, { ...FIXED, active: true, planSlugs: [] }, 201);
    const r = await runCli(
      ['coupons', 'create', '--app', 'app_1', '--code', 'fiveoff', '--amount', 'usd=500', '--amount', 'INR=40000', '--amount', 'JPY=500'],
      env,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests.map((q) => q.body)).toEqual([
      valid('CreateCouponRequestSchema', {
        code: 'fiveoff',
        discountType: 'AMOUNT',
        amounts: [
          { currency: 'USD', amountOff: 500 },
          { currency: 'INR', amountOff: 40000 },
          { currency: 'JPY', amountOff: 500 },
        ],
      }),
    ]);
    expect(r.stdout).toBe('✓ fiveoff  ₹400.00, ¥500, $5.00 off  INR,JPY,USD  any plan  active\n');
  });

  it.each([
    [[], 'CLI_COUPONS_DISCOUNT_REQUIRED'],
    [['--percent', '15', '--amount', 'USD=500'], 'CLI_COUPONS_DISCOUNT_REQUIRED'],
    [['--percent', '15', '--basis-points', '1500'], 'CLI_COUPONS_DISCOUNT_REQUIRED'],
    [['--percent', '0'], 'CLI_COUPONS_PERCENT_INVALID'],
    [['--percent', '101'], 'CLI_COUPONS_PERCENT_INVALID'],
    [['--percent', '12.345'], 'CLI_COUPONS_PERCENT_INVALID'],
    [['--basis-points', '10001'], 'CLI_COUPONS_BASIS_POINTS_INVALID'],
    [['--amount', 'USD'], 'CLI_COUPONS_AMOUNT_INVALID'],
    [['--amount', 'USD=5.00'], 'CLI_COUPONS_AMOUNT_INVALID'],
    [['--amount', 'USD=0'], 'CLI_COUPONS_AMOUNT_INVALID'],
    [['--amount', 'KWD=500'], 'CLI_COUPONS_AMOUNT_INVALID'],
    [['--amount', 'USD=500', '--amount', 'usd=600'], 'CLI_COUPONS_AMOUNT_INVALID'],
    [['--amount', 'USD=500', '--currencies', 'USD'], 'CLI_COUPONS_CURRENCIES_NOT_APPLICABLE'],
    [['--percent', '15', '--currencies', 'DOLLARS'], 'CLI_COUPONS_CURRENCIES_INVALID'],
    [['--percent', '15', '--starts-at', 'tomorrow'], 'CLI_COUPONS_DATE_INVALID'],
    [['--percent', '15', '--ends-at', '2026-12-01T09:30:00'], 'CLI_COUPONS_DATE_INVALID'],
    [['--percent', '15', '--max-redemptions', '0'], 'CLI_COUPONS_LIMIT_INVALID'],
  ])('coupons create %j is refused before any request', async (flags, code) => {
    stub.reset();
    const r = await runCli(['coupons', 'create', '--app', 'app_1', '--code', 'x', ...flags, '--json'], env);
    expect(r.code).toBe(1);
    const { error } = JSON.parse(r.stderr) as { error: { code: string; fix: string } };
    expect(error.code).toBe(code);
    expect(error.fix).toBeTruthy();
    expect(stub.requests).toEqual([]);
  });

  it('coupons create without --code is a usage error', async () => {
    const r = await runCli(['coupons', 'create', '--app', 'app_1', '--percent', '15', '--json'], env);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.stderr) as { error: { code: string } }).error.code).toBe('CLI_USAGE_ERROR');
  });

  it('coupons create passes the API refusal through', async () => {
    stub.reset();
    const error = { code: 'COUPON_CODE_TAKEN', message: 'taken', fix: 'Pick another code.' };
    stub.error(`POST ${COUPONS}`, 409, error);
    const r = await runCli(['coupons', 'create', '--app', 'app_1', '--code', 'launch', '--percent', '15', '--json'], env);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({ success: false, error });
  });

  // ---------- update ----------

  it('coupons update patches only what was given', async () => {
    stub.reset();
    stub.ok(`PATCH ${COUPONS}/fiveoff`, FIXED);
    const r = await runCli(
      ['coupons', 'update', 'fiveoff', '--app', 'app_1', '--active', 'false', '--amount', 'USD=500', '--amount', 'EUR=450', '--plans', '', '--json'],
      env,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests).toEqual([
      {
        key: `PATCH ${COUPONS}/fiveoff`,
        auth: AUTH,
        body: valid('UpdateCouponRequestSchema', {
          active: false,
          amounts: [
            { currency: 'USD', amountOff: 500 },
            { currency: 'EUR', amountOff: 450 },
          ],
          planSlugs: [],
        }),
      },
    ]);
    expect(JSON.parse(r.stdout)).toEqual(FIXED);
  });

  it('coupons update --basis-points and --currencies, in text', async () => {
    stub.reset();
    stub.ok(`PATCH ${COUPONS}/launch`, coupon({ basisPoints: 2000, currencies: ['USD'], coveredCurrencies: ['USD'] }));
    const r = await runCli(['coupons', 'update', 'launch', '--app', 'app_1', '--basis-points', '2000', '--currencies', 'usd'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests.map((q) => q.body)).toEqual([{ basisPoints: 2000, currencies: ['USD'] }]);
    expect(r.stdout).toBe('✓ launch  20% off  USD  any plan  active\n');
  });

  it('coupons update sets an end date and caps, and "none" removes one', async () => {
    stub.reset();
    stub.ok(`PATCH ${COUPONS}/launch`, coupon({ endsAt: '2026-12-01T00:00:00.000Z', maxRedemptions: 500 }));
    const set = await runCli(
      ['coupons', 'update', 'launch', '--app', 'app_1', '--ends-at', '2026-12-01', '--max-redemptions', '500', '--max-redemptions-per-user', 'none'],
      env,
    );
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toBe(
      ['✓ launch  15% off  any currency  any plan  active', '    ends 2026-12-01T00:00:00.000Z', '    at most 500 redemptions', ''].join('\n'),
    );
    await runCli(['coupons', 'update', 'launch', '--app', 'app_1', '--ends-at', 'none', '--max-redemptions', 'none', '--json'], env);
    expect(stub.requests.map((q) => q.body)).toEqual([
      valid('UpdateCouponRequestSchema', { endsAt: '2026-12-01T00:00:00.000Z', maxRedemptions: 500, maxRedemptionsPerUser: null }),
      valid('UpdateCouponRequestSchema', { endsAt: null, maxRedemptions: null }),
    ]);
  });

  it('coupons update passes the refusal of a cap below what is redeemed through, with the count in its fix', async () => {
    stub.reset();
    const error = {
      code: 'COUPON_LIMIT_BELOW_REDEEMED',
      message: 'This coupon already holds 3 redemptions (1 settled, 2 held by checkouts still open), so `maxRedemptions` cannot be 2.',
      fix: 'Send `maxRedemptions` of 3 or more, or null for no cap.',
      details: { field: 'maxRedemptions', requested: 2, redeemed: 3, settled: 1, reserved: 2 },
    };
    stub.error(`PATCH ${COUPONS}/launch`, 409, error);
    const r = await runCli(['coupons', 'update', 'launch', '--app', 'app_1', '--max-redemptions', '2', '--json'], env);
    expect(r.code).toBe(1);
    // The CLI prints an error's code, message and fix. The fix names the count.
    const { details: _details, ...printed } = error;
    expect(JSON.parse(r.stderr)).toEqual({ success: false, error: printed });
  });

  it('coupons update --help says --amount replaces the whole set', async () => {
    const r = await runCli(['coupons', 'update', '--help']);
    const help = r.stdout.replace(/\s+/g, ' ');
    expect(help).toContain('Replaces the whole set');
    expect(help).toContain('minor units of the currency, e.g. 1900 for $19.00, 5000 for ¥5,000');
  });

  it.each([
    [[], 'CLI_COUPONS_NO_CHANGE'],
    [['--active', 'yes'], 'CLI_COUPONS_ACTIVE_INVALID'],
    [['--amount', 'USD=1.5'], 'CLI_COUPONS_AMOUNT_INVALID'],
    [['--max-redemptions', '0'], 'CLI_COUPONS_LIMIT_INVALID'],
    [['--max-redemptions-per-user', 'null'], 'CLI_COUPONS_LIMIT_INVALID'],
    [['--ends-at', 'tomorrow'], 'CLI_COUPONS_DATE_INVALID'],
  ])('coupons update %j is refused before any request', async (flags, code) => {
    stub.reset();
    const r = await runCli(['coupons', 'update', 'launch', '--app', 'app_1', ...flags, '--json'], env);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.stderr) as { error: { code: string } }).error.code).toBe(code);
    expect(stub.requests).toEqual([]);
  });

  it('coupons update passes the API refusal through', async () => {
    stub.reset();
    const error = { code: 'COUPON_DISCOUNT_SHAPE_INVALID', message: 'wrong type', fix: 'Send amounts to an AMOUNT coupon.' };
    stub.error(`PATCH ${COUPONS}/launch`, 400, error);
    const r = await runCli(['coupons', 'update', 'launch', '--app', 'app_1', '--amount', 'USD=500', '--json'], env);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({ success: false, error });
  });
});
