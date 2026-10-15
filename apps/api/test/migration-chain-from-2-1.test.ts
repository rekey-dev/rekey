/**
 * The whole migration chain over a database shaped like the last stable
 * release, 2.1.0: migrated to the last migration that tag has, filled with
 * rows that name only columns 2.1.0 had, then deployed to the head in one
 * `prisma migrate deploy`, which is how a self-hoster on 2.1.0 meets 2.2.0.
 *
 * `money-migrations-over-existing-rows.test.ts` does the same from the shape
 * 2.2.0-rc.7 ran on. It runs in a database of its own, created and dropped
 * here.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCHEMA = path.join(REPO, 'prisma/schema.prisma');
const MIGRATIONS = path.join(REPO, 'prisma/migrations');
const PREFLIGHT = path.join(REPO, 'docs/upgrades/billing-money-model.preflight.sql');
/** The last migration present at tag v2.1.0. */
const LAST_IN_2_1_0 = '20260820200000_application_promote_and_disable';
const CHECKS = '20261014100001_price_and_coupon_column_drop_checks';

const DATABASE = `from21_${randomUUID().slice(0, 8)}_test`;

function databaseUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '');
  url.pathname = `/${DATABASE}`;
  return url.toString();
}

function prismaCli(args: string[]): string {
  try {
    return execFileSync('pnpm', ['exec', 'prisma', ...args], {
      cwd: REPO,
      env: { ...process.env, DATABASE_URL: databaseUrl() },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string };
    throw new Error(`${failure.stdout ?? ''}\n${failure.stderr ?? ''}`, { cause: err });
  }
}

/** The preflight queries that need no table newer than 2.1.0, comments dropped. */
function preflightForAnyRelease(): string[] {
  const partA = readFileSync(PREFLIGHT, 'utf8').split(/^-- =+ PART [ABC] =+$/m)[1] ?? '';
  return partA
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

const q = (value: string | number | null): string =>
  value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`;

/** Rows as 2.1.0 wrote them: a plan carries its own price, a coupon its own amount, and nothing has a price row. */
function rowsFrom21(): string[] {
  const sql: string[] = [];
  const application = (id: string, billingConfig: object) =>
    sql.push(
      `INSERT INTO "tenants" ("id", "name", "owner_email", "updated_at") VALUES (${q(`t_${id}`)}, ${q(id)}, ${q(`${id}@example.com`)}, now())`,
      `INSERT INTO "applications" ("id", "tenant_id", "name", "slug", "public_key", "auth_config", "billing_config", "updated_at")
       VALUES (${q(id)}, ${q(`t_${id}`)}, ${q(id)}, ${q(id)}, ${q(`pk_${id}`)}, '{}'::jsonb, ${q(JSON.stringify(billingConfig))}::jsonb, now())`,
    );
  const plan = (id: string, amount: number, currency: string, extra: { metadata?: object; perUnit?: number; kind?: string; status?: string } = {}) =>
    sql.push(
      `INSERT INTO "plans" ("id", "application_id", "slug", "name", "amount", "currency", "metadata", "price_per_unit_cents", "kind", "registration_status", "updated_at")
       VALUES (${q(id)}, 'app_a', ${q(id)}, ${q(id)}, ${amount}, ${q(currency)}, ${q(JSON.stringify(extra.metadata ?? {}))}::jsonb, ${q(extra.perUnit ?? null)},
               ${q(extra.kind ?? 'SUBSCRIPTION')}::"PlanKind", ${q(extra.status ?? 'NOT_REQUIRED')}::"PlanRegistrationStatus", now())`,
    );
  const subscription = (id: string, planId: string, extra: { status?: string; provider?: string; providerSubId?: string } = {}) =>
    sql.push(
      `INSERT INTO "end_users" ("id", "application_id", "email", "updated_at") VALUES (${q(`u_${id}`)}, 'app_a', ${q(`${id}@example.com`)}, now())`,
      `INSERT INTO "subscriptions" ("id", "application_id", "end_user_id", "plan_id", "status", "provider", "provider_sub_id", "updated_at")
       VALUES (${q(id)}, 'app_a', ${q(`u_${id}`)}, ${q(planId)}, ${q(extra.status ?? 'ACTIVE')}::"SubscriptionStatus", ${q(extra.provider ?? null)}, ${q(extra.providerSubId ?? null)}, now())`,
    );
  const payment = (id: string, subscriptionId: string, amount: number, currency: string, status: string, refundedAmount = 0) =>
    sql.push(
      `INSERT INTO "payments" ("id", "application_id", "subscription_id", "amount", "currency", "status", "refunded_amount", "updated_at")
       VALUES (${q(id)}, 'app_a', ${q(subscriptionId)}, ${amount}, ${q(currency)}, ${q(status)}::"PaymentStatus", ${refundedAmount}, now())`,
    );
  const coupon = (id: string, type: string, amountOff: number, currency: string | null) =>
    sql.push(
      `INSERT INTO "coupons" ("id", "application_id", "code", "discount_type", "amount_off", "currency", "updated_at")
       VALUES (${q(id)}, 'app_a', ${q(id)}, ${q(type)}::"CouponDiscountType", ${amountOff}, ${q(currency)}, now())`,
    );
  const credentials = (applicationId: string, provider: string) =>
    sql.push(
      `INSERT INTO "billing_credentials" ("id", "application_id", "provider", "ciphertext", "updated_at")
       VALUES (${q(`bc_${applicationId}_${provider}`)}, ${q(applicationId)}, ${q(provider)}, 'x', now())`,
    );

  application('app_a', { enabled: true, currency: 'eur' });
  application('app_b', {});

  plan('pl_pro', 2000, 'usd', { metadata: { stripe: { priceId: 'price_1', mode: 'live' }, features: { seats: 5 } }, status: 'REGISTERED' });
  plan('pl_inr', 149900, 'INR', { metadata: { razorpay: { planId: 'plan_rzp' } } });
  plan('pl_free', 0, 'USD');
  plan('pl_metered', 0, 'USD', { perUnit: 5, kind: 'USAGE' });
  // A per-unit figure an operator entered on a plan that is not metered.
  plan('pl_seat', 1000, 'USD', { perUnit: 3, metadata: { features: { seats: 1 } } });
  // Cannot be migrated: no price row can be made in "USDT".
  plan('pl_bad', 500, 'USDT');

  subscription('sub_paid', 'pl_pro', { provider: 'stripe', providerSubId: 'sub_1' });
  subscription('sub_inr', 'pl_inr', { provider: 'razorpay', providerSubId: 'sub_2' });
  subscription('sub_pending', 'pl_pro', { status: 'PENDING' });
  subscription('sub_free', 'pl_free');
  subscription('sub_metered', 'pl_metered', { provider: 'stripe', providerSubId: 'sub_3' });
  subscription('sub_on_bad', 'pl_bad', { provider: 'stripe', providerSubId: 'sub_4' });

  payment('pay_paid', 'sub_paid', 2000, 'usd', 'SUCCEEDED');
  payment('pay_refunded', 'sub_paid', 2000, 'USD', 'REFUNDED', 2000);

  coupon('c_fixed', 'AMOUNT', 500, 'usd');
  coupon('c_percent', 'PERCENT', 1500, null);
  // A fixed coupon with no currency, and a rate the API never accepted.
  coupon('c_no_currency', 'AMOUNT', 700, null);
  coupon('c_bad_rate', 'PERCENT', 20000, null);

  // 2.1.0 has no currency list: every one of these arrives at the money model empty.
  credentials('app_a', 'stripe');
  credentials('app_a', 'razorpay');
  credentials('app_b', 'paypal');
  return sql;
}

describe('the migration chain from a 2.1.0 database', () => {
  let db: PrismaClient;
  let workdir: string;
  let preflight: Array<Array<Record<string, unknown>>>;
  let refusal: string;

  const rows = <T = Record<string, unknown>>(sql: string) => db.$queryRawUnsafe<T[]>(sql);
  const one = async <T = Record<string, unknown>>(sql: string): Promise<T> => {
    const found = await rows<T>(sql);
    if (found.length !== 1) throw new Error(`expected one row, got ${found.length}: ${sql}`);
    return found[0]!;
  };
  const columnsOf = async (table: string) =>
    (await rows<{ column_name: string }>(`SELECT "column_name" FROM information_schema.columns WHERE "table_name" = ${q(table)}`)).map((row) => row.column_name);
  const subscription = (id: string) =>
    one<{ plan_price_id: string | null; currency: string | null; unit_amount: number | null }>(
      `SELECT "plan_price_id", "currency", "unit_amount" FROM "subscriptions" WHERE "id" = ${q(id)}`,
    );
  const defaultPrice = (plan: string) =>
    rows<{ currency: string; amount: number; metadata: unknown; registration_status: string }>(
      `SELECT pp."currency", pp."amount", pp."metadata", pp."registration_status"::text
         FROM "plans" AS p JOIN "plan_prices" AS pp ON pp."id" = p."default_price_id" WHERE p."id" = ${q(plan)}`,
    );

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${DATABASE}"`);
    workdir = mkdtempSync(path.join(os.tmpdir(), 'rekey-from21-'));
    cpSync(SCHEMA, path.join(workdir, 'schema.prisma'));
    cpSync(path.join(MIGRATIONS, 'migration_lock.toml'), path.join(workdir, 'migrations/migration_lock.toml'));
    for (const name of readdirSync(MIGRATIONS)) {
      if (name <= LAST_IN_2_1_0 && !name.endsWith('.toml')) cpSync(path.join(MIGRATIONS, name), path.join(workdir, 'migrations', name), { recursive: true });
    }
    prismaCli(['migrate', 'deploy', '--schema', path.join(workdir, 'schema.prisma')]);

    db = new PrismaClient({ datasourceUrl: databaseUrl() });
    for (const statement of rowsFrom21()) await db.$executeRawUnsafe(statement);

    preflight = [];
    for (const query of preflightForAnyRelease()) preflight.push(await rows(query));

    refusal = await Promise.resolve()
      .then(() => prismaCli(['migrate', 'deploy', '--schema', SCHEMA]))
      .then(
        () => 'the deploy was not refused',
        (err: Error) => err.message,
      );
  }, 240_000);

  afterAll(async () => {
    await db?.$disconnect();
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    if (workdir !== undefined) rmSync(workdir, { recursive: true, force: true });
  });

  it('starts from a schema with no price rows, no subscription price and no provider currency list', () => {
    // The seed can only name columns that existed, or the inserts would have failed.
    expect(rowsFrom21().join('\n')).not.toMatch(/plan_prices|plan_price_id|unit_amount|"currencies"|basis_points/);
    expect(readdirSync(path.join(workdir, 'migrations')).filter((name) => !name.endsWith('.toml')).sort().at(-1)).toBe(LAST_IN_2_1_0);
  });

  it('is told before upgrading, by the part of the preflight that runs on 2.1.0, which rows will stop it', () => {
    const [rescaled, malformed, badRate, threeDecimal, perUnit, registrations, httpEndpoints, oldReportingKey, perUnitConflict, negative] = preflight;
    expect(rescaled).toEqual([]);
    expect(malformed!.map((row) => [row.source, row.id])).toEqual([['coupons', 'c_no_currency'], ['plans', 'pl_bad']]);
    expect(badRate!.map((row) => row.id)).toEqual(['c_bad_rate']);
    expect(threeDecimal).toEqual([]);
    expect(perUnit!.map((row) => row.slug).sort()).toEqual(['pl_metered', 'pl_seat']);
    expect([oldReportingKey, perUnitConflict, negative]).toEqual([[], [], []]);
    expect(registrations!.map((row) => [row.slug, row.provider])).toEqual([['pl_inr', 'razorpay'], ['pl_pro', 'stripe']]);
    expect(httpEndpoints).toEqual([]);
  });

  it('is refused by the contract checks for each row no migration could place, with its table, its count and what to do', async () => {
    expect(refusal).toContain(CHECKS);
    expect(refusal).toContain('This migration changed nothing; the migrations before it are applied.');
    expect(refusal).toMatch(/"subscriptions": 1 row\(s\) have some of "plan_price_id", "currency" and "unit_amount" set and not the others/);
    expect(refusal).toMatch(/"plans": 1 row\(s\) have an "amount" and no default price row/);
    expect(refusal).toMatch(/"coupons": 1 row\(s\) are percentage coupons with no rate in "basis_points"/);
    expect(refusal).toMatch(/"coupons": 1 row\(s\) are fixed-amount coupons with no row in "coupon_amounts"/);
    expect(refusal).toContain(`prisma migrate resolve --rolled-back ${CHECKS}`);
    // Everything before the contract applied, and nothing of it did.
    expect(await columnsOf('plans')).toEqual(expect.arrayContaining(['amount', 'currency', 'price_per_unit_cents', 'default_price_id', 'is_free']));
    expect(await columnsOf('coupons')).toEqual(expect.arrayContaining(['amount_off', 'currency', 'basis_points']));
    // No value was made up for the rows that were refused.
    expect(await subscription('sub_on_bad')).toEqual({ plan_price_id: null, currency: 'USDT', unit_amount: 500 });
    expect(await rows(`SELECT 1 FROM "plan_prices" WHERE "plan_id" = 'pl_bad'`)).toEqual([]);
    expect(await rows(`SELECT 1 FROM "coupon_amounts" WHERE "coupon_id" = 'c_no_currency'`)).toEqual([]);
    expect(await one(`SELECT "basis_points" FROM "coupons" WHERE "id" = 'c_bad_rate'`)).toEqual({ basis_points: null });
  });

  it('deploys once an operator has corrected those rows, and every constraint holds', async () => {
    for (const correction of [
      `INSERT INTO "plan_prices" ("id", "application_id", "plan_id", "currency", "amount", "updated_at") VALUES ('pp_by_hand', 'app_a', 'pl_bad', 'USD', 500, now())`,
      `UPDATE "plans" SET "currency" = 'USD', "default_price_id" = 'pp_by_hand' WHERE "id" = 'pl_bad'`,
      `UPDATE "subscriptions" SET "plan_price_id" = 'pp_by_hand', "currency" = 'USD' WHERE "id" = 'sub_on_bad'`,
      `INSERT INTO "coupon_amounts" ("id", "application_id", "coupon_id", "currency", "amount_off") VALUES ('ca_by_hand', 'app_a', 'c_no_currency', 'USD', 700)`,
      `DELETE FROM "coupons" WHERE "id" = 'c_bad_rate'`,
    ]) {
      await db.$executeRawUnsafe(correction);
    }
    prismaCli(['migrate', 'resolve', '--rolled-back', CHECKS, '--schema', SCHEMA]);
    prismaCli(['migrate', 'deploy', '--schema', SCHEMA]);
    expect(prismaCli(['migrate', 'status', '--schema', SCHEMA])).toContain('Database schema is up to date');

    const plans = await columnsOf('plans');
    for (const dropped of ['amount', 'currency', 'price_per_unit_cents']) expect(plans, dropped).not.toContain(dropped);
    const coupons = await columnsOf('coupons');
    for (const dropped of ['amount_off', 'currency']) expect(coupons, dropped).not.toContain(dropped);
    expect(
      (await rows<{ conname: string }>(
        `SELECT "conname" FROM pg_constraint WHERE "convalidated" AND "conname" IN
           ('subscriptions_price_snapshot', 'subscriptions_plan_price_id_plan_id_fkey', 'plans_free_has_no_price', 'coupons_rate_by_kind', 'plan_prices_currency_code')
          ORDER BY 1`,
      )).map((row) => row.conname),
    ).toEqual(['coupons_rate_by_kind', 'plan_prices_currency_code', 'plans_free_has_no_price', 'subscriptions_plan_price_id_plan_id_fkey', 'subscriptions_price_snapshot']);
    expect(
      await rows(`SELECT "table_name" FROM information_schema.columns WHERE "column_name" = 'currencies' AND "is_nullable" = 'YES' AND "table_name" IN ('coupons', 'billing_credentials')`),
    ).toEqual([]);
  }, 240_000);

  it('carries each price to its row exactly as 2.1.0 stored it', async () => {
    expect(await defaultPrice('pl_pro')).toEqual([{ currency: 'USD', amount: 2000, metadata: { stripe: { priceId: 'price_1', mode: 'live' } }, registration_status: 'REGISTERED' }]);
    expect(await defaultPrice('pl_inr')).toEqual([{ currency: 'INR', amount: 149900, metadata: { razorpay: { planId: 'plan_rzp' } }, registration_status: 'NOT_REQUIRED' }]);
    expect(await defaultPrice('pl_free')).toEqual([]);
    expect(await defaultPrice('pl_metered')).toEqual([]);
    expect(await rows(`SELECT "id", "is_free" FROM "plans" ORDER BY 1`)).toEqual([
      { id: 'pl_bad', is_free: false },
      { id: 'pl_free', is_free: true },
      { id: 'pl_inr', is_free: false },
      { id: 'pl_metered', is_free: false },
      { id: 'pl_pro', is_free: false },
      { id: 'pl_seat', is_free: false },
    ]);
    // The per-unit figure is in the plan's metadata, as stored, beside what was already there.
    expect(await rows(`SELECT "id", "metadata" FROM "plans" WHERE "metadata" ? 'pricePerUnitCents' ORDER BY 1`)).toEqual([
      { id: 'pl_metered', metadata: { pricePerUnitCents: 5 } },
      { id: 'pl_seat', metadata: { features: { seats: 1 }, pricePerUnitCents: 3 } },
    ]);
    // The plan's own metadata is left as it was.
    expect(await one(`SELECT "metadata" FROM "plans" WHERE "id" = 'pl_pro'`)).toEqual({
      metadata: { stripe: { priceId: 'price_1', mode: 'live' }, features: { seats: 5 } },
    });
  });

  it('prices the subscriptions the applied migrations could answer for, and leaves the others with none', async () => {
    const pro = (await one<{ default_price_id: string }>(`SELECT "default_price_id" FROM "plans" WHERE "id" = 'pl_pro'`)).default_price_id;
    const inr = (await one<{ default_price_id: string }>(`SELECT "default_price_id" FROM "plans" WHERE "id" = 'pl_inr'`)).default_price_id;
    // 2.1.0 stored this plan's currency in lower case; the subscription takes the price row's spelling.
    expect(await subscription('sub_paid')).toEqual({ plan_price_id: pro, currency: 'USD', unit_amount: 2000 });
    expect(await subscription('sub_inr')).toEqual({ plan_price_id: inr, currency: 'INR', unit_amount: 149900 });
    const none = { plan_price_id: null, currency: null, unit_amount: null };
    expect(await subscription('sub_pending')).toEqual(none);
    expect(await subscription('sub_free')).toEqual(none);
    expect(await subscription('sub_metered')).toEqual(none);
    expect(await subscription('sub_on_bad')).toEqual({ plan_price_id: 'pp_by_hand', currency: 'USD', unit_amount: 500 });
  });

  it('gives each coupon its terms, each provider a currency list and each Application its reporting currency', async () => {
    expect(await rows(`SELECT "id", "discount_type"::text, "basis_points" FROM "coupons" ORDER BY 1`)).toEqual([
      { id: 'c_fixed', discount_type: 'AMOUNT', basis_points: null },
      { id: 'c_no_currency', discount_type: 'AMOUNT', basis_points: null },
      { id: 'c_percent', discount_type: 'PERCENT', basis_points: 1500 },
    ]);
    expect(await rows(`SELECT "coupon_id", "currency", "amount_off" FROM "coupon_amounts" ORDER BY 1`)).toEqual([
      { coupon_id: 'c_fixed', currency: 'USD', amount_off: 500 },
      { coupon_id: 'c_no_currency', currency: 'USD', amount_off: 700 },
    ]);

    const lists = await rows<{ application_id: string; provider: string; currencies: string[] }>(
      `SELECT "application_id", "provider", "currencies" FROM "billing_credentials" ORDER BY 1, 2`,
    );
    expect(lists.map((row) => [row.application_id, row.provider])).toEqual([['app_a', 'razorpay'], ['app_a', 'stripe'], ['app_b', 'paypal']]);
    expect(lists[0]!.currencies).toEqual(['INR']);
    expect(lists[1]!.currencies.length).toBeGreaterThan(100);
    expect(lists[2]!.currencies).toHaveLength(22);

    expect(await rows(`SELECT "id", "billing_config" FROM "applications" ORDER BY 1`)).toEqual([
      { id: 'app_a', billing_config: { enabled: true, reportingCurrency: 'EUR' } },
      { id: 'app_b', billing_config: {} },
    ]);
  });

  it('turns a refunded total into a refund row, and keeps every payment', async () => {
    expect(await rows(`SELECT "payment_id", "amount", "currency" FROM "refunds"`)).toEqual([{ payment_id: 'pay_refunded', amount: 2000, currency: 'USD' }]);
    expect(await rows(`SELECT "id", "amount" FROM "payments" ORDER BY 1`)).toEqual([
      { id: 'pay_paid', amount: 2000 },
      { id: 'pay_refunded', amount: 2000 },
    ]);
  });
});
