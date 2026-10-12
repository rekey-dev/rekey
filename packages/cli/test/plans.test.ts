/**
 * `rekey plans list|create` output and `rekey plans prices …`, through the
 * compiled binary against the stub server.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_KEY, OPERATOR_TOKEN, paged, plan, price, runCli, startStubServer, type StubServer } from './helpers.js';

const INR = price({ id: 'pp_inr', currency: 'INR', amount: 149900, isDefault: false, registration: { status: 'NOT_REQUIRED', error: null } });
const JPY = price({ id: 'pp_jpy', currency: 'JPY', amount: 5000, countries: ['JP'], isDefault: false, registration: { status: 'FAILED', error: 'currency not enabled' } });
const PRO = plan({ prices: [price(), INR, JPY] });
const FREE = plan({ id: 'plan_free', slug: 'free', name: 'Free', isFree: true, prices: [] });

const PLANS_PAGE = 'GET /api/v1/tenant/applications/app_1/plans?limit=100&offset=0';
const INR_PRICE = '/api/v1/tenant/applications/app_1/plans/pro/prices/INR';

describe('rekey plans', () => {
  let stub: StubServer;
  let operator: Record<string, string>;
  let admin: Record<string, string>;

  beforeAll(async () => {
    stub = await startStubServer();
    operator = { REKEY_URL: stub.url, REKEY_OPERATOR_TOKEN: OPERATOR_TOKEN };
    admin = { REKEY_URL: stub.url, SUPER_ADMIN_KEY: ADMIN_KEY };
  });

  afterAll(async () => {
    await stub.close();
  });

  // ---------- plans list / create ----------

  it('plans list prints each plan with its money formatted, and every price under it', async () => {
    stub.reset();
    stub.ok('GET /api/v1/admin/applications/app_1/plans', paged([PRO, FREE]));
    const r = await runCli(['plans', 'list', '--app', 'app_1'], admin);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests[0]?.auth).toBe(`Bearer ${ADMIN_KEY}`);
    expect(r.stdout).toBe(
      [
        'pro                  $19.00/MONTH  Pro',
        '    USD  $19.00  default  pp_usd  REGISTERED',
        '    INR  ₹1,499.00  where INR is local  pp_inr  NOT_REQUIRED',
        '    JPY  ¥5,000  JP  pp_jpy  FAILED: currency not enabled',
        'free                 free  Free',
        '',
      ].join('\n'),
    );
  });

  it('plans list --json is the API page under `plans`', async () => {
    stub.reset();
    stub.ok('GET /api/v1/admin/applications/app_1/plans?includeInactive=true', paged([PRO, FREE]));
    const r = await runCli(['plans', 'list', '--app', 'app_1', '--include-inactive', '--json'], admin);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ plans: [PRO, FREE], page: { total: 2, limit: 50, offset: 0, hasMore: false } });
  });

  it('plans create prints the created plan at its formatted price', async () => {
    stub.reset();
    const created = plan({ slug: 'yen', name: 'Yen', prices: [price({ id: 'pp_1', currency: 'JPY', amount: 5000 })] });
    stub.ok('POST /api/v1/admin/applications/app_1/plans', created, 201);
    const args = ['plans', 'create', '--app', 'app_1', '--slug', 'yen', '--name', 'Yen', '--amount', '5000', '--currency', 'JPY'];
    const r = await runCli(args, admin);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests).toEqual([
      {
        key: 'POST /api/v1/admin/applications/app_1/plans',
        body: { slug: 'yen', name: 'Yen', price: { currency: 'JPY', amount: 5000 }, interval: 'MONTH' },
        auth: `Bearer ${ADMIN_KEY}`,
      },
    ]);
    expect(r.stdout).toBe('✓ yen [SUBSCRIPTION]  ¥5,000/MONTH\n');
  });

  it.each([
    [['--amount', '19.99'], 'whole number'],
    [['--amount', '1900', '--currency', 'KWD'], 'KWD is not a currency a price can be in'],
    [['--amount', '500050', '--currency', 'HUF'], 'whole units'],
  ])('plans create %j is refused before any request', async (flags, fragment) => {
    stub.reset();
    const r = await runCli(['plans', 'create', '--app', 'app_1', '--slug', 's', '--name', 'S', ...flags, '--json'], admin);
    expect(r.code).toBe(1);
    const { error } = JSON.parse(r.stderr) as { error: { code: string; message: string; fix: string } };
    expect(error.code).toBe('CLI_PLANS_AMOUNT_INVALID');
    expect(error.message).toContain(fragment);
    expect(error.fix).toBeTruthy();
    expect(stub.requests).toEqual([]);
  });

  it('plans create --help states the unit of --amount', async () => {
    const r = await runCli(['plans', 'create', '--help']);
    expect(r.stdout.replace(/\s+/g, ' ')).toContain('minor units of the currency, e.g. 1900 for $19.00, 5000 for ¥5,000');
  });

  // ---------- plans prices list ----------

  it('plans prices list finds the plan by slug and prints every price formatted', async () => {
    stub.reset();
    stub.ok(PLANS_PAGE, paged([FREE, PRO], 100));
    const r = await runCli(['plans', 'prices', 'list', 'pro', '--app', 'app_1'], operator);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests).toEqual([{ key: PLANS_PAGE, body: undefined, auth: `Bearer ${OPERATOR_TOKEN}` }]);
    expect(r.stdout).toBe(
      [
        'USD  $19.00  default  pp_usd  REGISTERED',
        'INR  ₹1,499.00  where INR is local  pp_inr  NOT_REQUIRED',
        'JPY  ¥5,000  JP  pp_jpy  FAILED: currency not enabled',
        '',
      ].join('\n'),
    );
  });

  it('plans prices list --json carries the plan and its prices, and follows pages to find it', async () => {
    stub.reset();
    stub.ok(PLANS_PAGE, paged([FREE], 100, 0, 101));
    stub.ok('GET /api/v1/tenant/applications/app_1/plans?limit=100&offset=100', paged([PRO], 100, 100, 101));
    const r = await runCli(['plans', 'prices', 'list', 'plan_pro', '--app', 'app_1', '--json'], operator);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests).toHaveLength(2);
    expect(JSON.parse(r.stdout)).toEqual({
      plan: { id: 'plan_pro', slug: 'pro', isFree: false, defaultPriceId: 'pp_usd' },
      prices: PRO.prices,
    });
  });

  it('plans prices list says a free plan has no prices', async () => {
    stub.reset();
    stub.ok(PLANS_PAGE, paged([FREE], 100));
    const r = await runCli(['plans', 'prices', 'list', 'free', '--app', 'app_1'], operator);
    expect(r.stdout).toBe('free is free: it has no prices\n');
  });

  it('plans prices list fails with a fix when the plan is not there', async () => {
    stub.reset();
    stub.ok(PLANS_PAGE, paged([FREE], 100));
    const r = await runCli(['plans', 'prices', 'list', 'nope', '--app', 'app_1', '--json'], operator);
    expect(r.code).toBe(1);
    const { error } = JSON.parse(r.stderr) as { error: { code: string; fix: string } };
    expect(error.code).toBe('CLI_PLANS_PLAN_NOT_FOUND');
    expect(error.fix).toContain('rekey plans list --app app_1');
  });

  // ---------- plans prices add / update ----------

  it('plans prices needs an operator token, not the admin key', async () => {
    stub.reset();
    const r = await runCli(['plans', 'prices', 'add', 'pro', 'INR', '149900', '--app', 'app_1', '--json'], admin);
    expect(r.code).toBe(1);
    const { error } = JSON.parse(r.stderr) as { error: { code: string; fix: string } };
    expect(error.code).toBe('CLI_OPERATOR_TOKEN_MISSING');
    expect(error.fix).toContain('billing:write');
    expect(error.fix).toContain('REKEY_OPERATOR_TOKEN');
    expect(stub.requests).toEqual([]);
  });

  it('plans prices add puts the amount and countries, upper-cased, and prints the saved price', async () => {
    stub.reset();
    const saved = { ...INR, countries: ['IN', 'NP'] };
    stub.ok(`PUT ${INR_PRICE}`, saved);
    const args = ['plans', 'prices', 'add', 'pro', 'inr', '149900', '--app', 'app_1', '--countries', 'in, np,IN'];
    const json = await runCli([...args, '--json'], operator);
    expect(json.code, json.stderr).toBe(0);
    expect(stub.requests).toEqual([
      { key: `PUT ${INR_PRICE}`, body: { amount: 149900, countries: ['IN', 'NP'] }, auth: `Bearer ${OPERATOR_TOKEN}` },
    ]);
    expect(JSON.parse(json.stdout)).toEqual(saved);

    const text = await runCli(args, operator);
    expect(text.stdout).toBe('✓ pro  INR  ₹1,499.00  IN,NP  pp_inr  NOT_REQUIRED\n');
  });

  it('plans prices add sends no countries when the flag is absent, and prints a zero-decimal amount whole', async () => {
    stub.reset();
    const key = 'PUT /api/v1/tenant/applications/app_1/plans/pro/prices/JPY';
    stub.ok(key, price({ id: 'pp_jpy', currency: 'JPY', amount: 5000, isDefault: false }));
    const r = await runCli(['plans', 'prices', 'add', 'pro', 'JPY', '5000', '--app', 'app_1'], operator);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests.map((q) => q.body)).toEqual([{ amount: 5000 }]);
    expect(r.stdout).toBe('✓ pro  JPY  ¥5,000  where JPY is local  pp_jpy  REGISTERED\n');
  });

  it.each([
    [['pro', 'INR', '1499.00'], 'CLI_PLANS_AMOUNT_INVALID'],
    [['pro', 'INR', '0'], 'CLI_PLANS_AMOUNT_INVALID'],
    [['pro', 'HUF', '500050'], 'CLI_PLANS_AMOUNT_INVALID'],
    [['pro', 'KWD', '1000'], 'CLI_PLANS_AMOUNT_INVALID'],
    [['pro', 'RUPEE', '149900'], 'CLI_PLANS_CURRENCY_INVALID'],
    [['pro', 'INR', '149900', '--countries', 'IN,IND'], 'CLI_PLANS_COUNTRIES_INVALID'],
  ])('plans prices add %j is refused before any request', async (args, code) => {
    stub.reset();
    const r = await runCli(['plans', 'prices', 'add', ...args, '--app', 'app_1', '--json'], operator);
    expect(r.code).toBe(1);
    const { error } = JSON.parse(r.stderr) as { error: { code: string; fix: string } };
    expect(error.code).toBe(code);
    expect(error.fix).toBeTruthy();
    expect(stub.requests).toEqual([]);
  });

  it('plans prices add without an amount is a usage error', async () => {
    const r = await runCli(['plans', 'prices', 'add', 'pro', 'INR', '--app', 'app_1', '--json'], operator);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.stderr) as { error: { code: string } }).error.code).toBe('CLI_USAGE_ERROR');
  });

  it('plans prices update sends only what was given', async () => {
    stub.reset();
    stub.ok(`PUT ${INR_PRICE}`, INR);
    const countriesOnly = await runCli(['plans', 'prices', 'update', 'pro', 'INR', '--app', 'app_1', '--countries', ''], operator);
    expect(countriesOnly.code, countriesOnly.stderr).toBe(0);
    const amountOnly = await runCli(['plans', 'prices', 'update', 'pro', 'INR', '--app', 'app_1', '--amount', '159900', '--json'], operator);
    expect(amountOnly.code, amountOnly.stderr).toBe(0);
    expect(stub.requests.map((q) => q.body)).toEqual([{ countries: [] }, { amount: 159900 }]);
    expect(countriesOnly.stdout).toBe('✓ pro  INR  ₹1,499.00  where INR is local  pp_inr  NOT_REQUIRED\n');
    expect(JSON.parse(amountOnly.stdout)).toEqual(INR);
  });

  it('plans prices update with nothing to change is refused before any request', async () => {
    stub.reset();
    const r = await runCli(['plans', 'prices', 'update', 'pro', 'INR', '--app', 'app_1', '--json'], operator);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.stderr) as { error: { code: string } }).error.code).toBe('CLI_PLANS_PRICE_NO_CHANGE');
    expect(stub.requests).toEqual([]);
  });

  it('plans prices update passes the API refusal through', async () => {
    stub.reset();
    const error = { code: 'PLAN_PRICE_IMMUTABLE', message: 'registered', fix: 'Retire the plan and create a replacement.' };
    stub.error(`PUT ${INR_PRICE}`, 409, error);
    const r = await runCli(['plans', 'prices', 'update', 'pro', 'INR', '--amount', '159900', '--app', 'app_1', '--json'], operator);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({ success: false, error });
  });

  // ---------- plans local-prices ----------

  it('plans local-prices patches the rule, upper-cased, with the operator token, and prints what it is now', async () => {
    stub.reset();
    const key = 'PATCH /api/v1/tenant/applications/app_1/plans/pro';
    stub.ok(key, plan({ localPrices: 'OFF' }));
    const r = await runCli(['plans', 'local-prices', 'pro', 'off', '--app', 'app_1'], operator);
    expect(r.code, r.stderr).toBe(0);
    expect(stub.requests).toEqual([{ key, body: { localPrices: 'OFF' }, auth: `Bearer ${OPERATOR_TOKEN}` }]);
    expect(r.stdout).toBe('✓ pro  local prices: off\n');
  });

  it('plans local-prices refuses a rule it does not know before any request is sent', async () => {
    stub.reset();
    const r = await runCli(['plans', 'local-prices', 'pro', 'any', '--app', 'app_1', '--json'], operator);
    expect(r.code).toBe(1);
    const { error } = JSON.parse(r.stderr) as { error: { code: string; fix: string } };
    expect(error.code).toBe('CLI_PLANS_LOCAL_PRICES_INVALID');
    expect(error.fix).toContain('inherit');
    expect(stub.requests).toEqual([]);
  });

  // ---------- plans prices archive ----------

  it('plans prices archive deletes the price and says what that means', async () => {
    stub.reset();
    stub.ok(`DELETE ${INR_PRICE}`, { deleted: true });
    const json = await runCli(['plans', 'prices', 'archive', 'pro', 'inr', '--app', 'app_1', '--json'], operator);
    expect(json.code, json.stderr).toBe(0);
    expect(stub.requests).toEqual([{ key: `DELETE ${INR_PRICE}`, body: undefined, auth: `Bearer ${OPERATOR_TOKEN}` }]);
    expect(JSON.parse(json.stdout)).toEqual({ plan: 'pro', currency: 'INR', sold: false });
    const text = await runCli(['plans', 'prices', 'archive', 'pro', 'INR', '--app', 'app_1'], operator);
    expect(text.stdout).toBe('✓ pro  INR price is no longer sold\n');
  });

  it('plans prices archive passes PLAN_PRICE_IN_USE through', async () => {
    stub.reset();
    const error = { code: 'PLAN_PRICE_IN_USE', message: 'in use', fix: 'Wait for those subscriptions to end.' };
    stub.error(`DELETE ${INR_PRICE}`, 409, error);
    const r = await runCli(['plans', 'prices', 'archive', 'pro', 'INR', '--app', 'app_1', '--json'], operator);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({ success: false, error });
  });

  it('the removed `set` and `remove` are unknown commands', async () => {
    const set = await runCli(['plans', 'prices', 'set', 'pro', 'INR', '149900', '--app', 'app_1', '--json'], operator);
    expect(set.code).toBe(1);
    expect((JSON.parse(set.stderr) as { error: { code: string } }).error.code).toBe('CLI_USAGE_ERROR');
  });
});
