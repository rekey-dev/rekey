/**
 * The money-model migrations, applied in order over rows an older API wrote.
 *
 * `money-v2-backfills.test.ts` runs each backfill against a schema that
 * already has every new column and constraint. This file is the other half:
 * a database migrated to just before the first money-model migration, filled
 * with awkward old-shaped rows across two Applications, and then taken the
 * rest of the way with `prisma migrate deploy`, which is how production meets
 * them. It runs in a database of its own, created and dropped here.
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
const SPECS = path.join(REPO, 'docs/specs');
const FIRST = '20261011100001_money_v2_01_plan_default_price';
const RESCALED = ['HUF', 'TWD', 'ISK', 'UGX', 'MGA'];

const DATABASE = `mv2_inorder_${randomUUID().slice(0, 8)}_test`;

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

function migrationSql(suffix: string): string {
  const dir = readdirSync(MIGRATIONS).find((name) => name.endsWith(suffix));
  if (dir === undefined) throw new Error(`no migration ends with ${suffix}`);
  return readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
}

/** A SQL file as its statements, comments dropped. */
function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

const q = (value: string | number | null): string =>
  value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`;

interface OldSubscription {
  plan: string;
  status?: string;
  currency?: string;
  unitAmount?: number;
  planPriceId?: string;
  provider?: string;
}

interface OldPayment {
  subscription?: string;
  amount: number;
  currency?: string;
  status: string;
  refundedAmount?: number;
  metadata?: object;
}

/** Old-shaped rows, as INSERT statements that name only columns that existed before the money model. */
function seedFor(application: string) {
  const sql: string[] = [];
  const prefixed = (id: string) => `${application}_${id}`;
  return {
    sql,
    plan(id: string, amount: number, currency: string, extra: { metadata?: object; perUnit?: number; kind?: string; status?: string } = {}) {
      sql.push(
        `INSERT INTO "plans" ("id", "application_id", "slug", "name", "amount", "currency", "metadata", "price_per_unit_cents", "kind", "registration_status", "updated_at")
         VALUES (${q(id)}, ${q(application)}, ${q(id)}, ${q(id)}, ${amount}, ${q(currency)}, ${q(JSON.stringify(extra.metadata ?? {}))}::jsonb,
                 ${q(extra.perUnit ?? null)}, ${q(extra.kind ?? 'SUBSCRIPTION')}::"PlanKind", ${q(extra.status ?? 'NOT_REQUIRED')}::"PlanRegistrationStatus", now())`,
      );
    },
    price(id: string, plan: string, currency: string, amount: number, extra: { application?: string; metadata?: object; createdAt?: string } = {}) {
      sql.push(
        `INSERT INTO "plan_prices" ("id", "application_id", "plan_id", "currency", "amount", "metadata", "created_at", "updated_at")
         VALUES (${q(id)}, ${q(extra.application ?? application)}, ${q(plan)}, ${q(currency)}, ${amount}, ${q(JSON.stringify(extra.metadata ?? {}))}::jsonb,
                 ${q(extra.createdAt ?? '2026-10-10T12:00:00Z')}::timestamp, now())`,
      );
    },
    subscription(id: string, data: OldSubscription) {
      sql.push(
        `INSERT INTO "end_users" ("id", "application_id", "email", "updated_at") VALUES (${q(prefixed(`u_${id}`))}, ${q(application)}, ${q(`${id}@example.com`)}, now())`,
        `INSERT INTO "subscriptions" ("id", "application_id", "end_user_id", "plan_id", "status", "currency", "unit_amount", "plan_price_id", "provider", "updated_at")
         VALUES (${q(id)}, ${q(application)}, ${q(prefixed(`u_${id}`))}, ${q(data.plan)}, ${q(data.status ?? 'ACTIVE')}::"SubscriptionStatus",
                 ${q(data.currency ?? null)}, ${q(data.unitAmount ?? null)}, ${q(data.planPriceId ?? null)}, ${q(data.provider ?? null)}, now())`,
      );
    },
    payment(id: string, data: OldPayment) {
      sql.push(
        `INSERT INTO "payments" ("id", "application_id", "subscription_id", "amount", "currency", "status", "refunded_amount", "metadata", "updated_at")
         VALUES (${q(id)}, ${q(application)}, ${q(data.subscription ?? null)}, ${data.amount}, ${q(data.currency ?? 'USD')}, ${q(data.status)}::"PaymentStatus",
                 ${data.refundedAmount ?? 0}, ${q(JSON.stringify(data.metadata ?? {}))}::jsonb, '2026-09-15T08:00:00Z'::timestamp)`,
      );
    },
    unapplied(id: string, payment: string, provider: string, status: string, extra: { refundId?: string; note?: string } = {}) {
      sql.push(
        `INSERT INTO "unapplied_payments" ("id", "application_id", "payment_id", "provider", "amount", "currency", "status", "provider_refund_id", "resolution_note", "resolved_at", "updated_at")
         VALUES (${q(id)}, ${q(application)}, ${q(payment)}, ${q(provider)}, 2000, 'USD', ${q(status)}::"UnappliedPaymentStatus", ${q(extra.refundId ?? null)}, ${q(extra.note ?? null)},
                 ${status === 'REFUNDED' ? `'2026-09-20T09:00:00Z'::timestamp` : 'NULL'}, now())`,
      );
    },
    session(id: string, subscription: string, data: { kind: string; provider?: string; status?: string; currency?: string; unitAmount?: number; metadata?: object }) {
      sql.push(
        `INSERT INTO "checkout_sessions" ("id", "application_id", "end_user_id", "subscription_id", "provider", "provider_session_id", "mode", "payment_mode", "kind", "status",
                                          "currency", "unit_amount", "success_url", "cancel_url", "expires_at", "metadata", "updated_at")
         VALUES (${q(id)}, ${q(application)}, ${q(prefixed(`u_${subscription}`))}, ${q(subscription)}, ${q(data.provider ?? 'stripe')}, ${q(`ps_${id}`)}, 'EMBEDDED', 'TEST',
                 ${q(data.kind)}::"CheckoutKind", ${q(data.status ?? 'OPEN')}::"CheckoutSessionStatus", ${q(data.currency ?? null)}, ${q(data.unitAmount ?? null)},
                 'https://app.example/ok', 'https://app.example/no', now(), ${q(JSON.stringify(data.metadata ?? {}))}::jsonb, now())`,
      );
    },
    coupon(id: string, type: string, amountOff: number, currency: string | null) {
      sql.push(
        `INSERT INTO "coupons" ("id", "application_id", "code", "discount_type", "amount_off", "currency", "updated_at")
         VALUES (${q(id)}, ${q(application)}, ${q(id)}, ${q(type)}::"CouponDiscountType", ${amountOff}, ${q(currency)}, now())`,
      );
    },
    credentials(provider: string, currencies: string | null) {
      sql.push(
        `INSERT INTO "billing_credentials" ("id", "application_id", "provider", "ciphertext", "currencies", "updated_at")
         VALUES (${q(prefixed(`bc_${provider}`))}, ${q(application)}, ${q(provider)}, 'x', ${currencies === null ? 'NULL' : `${q(currencies)}::text[]`}, now())`,
      );
    },
    ledger(id: string, key: string) {
      sql.push(
        `INSERT INTO "credit_ledger" ("id", "application_id", "subject_key", "delta", "reason", "balance_after", "idempotency_key")
         VALUES (${q(id)}, ${q(application)}, ${q(`u:${id}`)}, 100, 'PURCHASE', 100, ${q(key)})`,
      );
    },
  };
}

function oldRows(): string[] {
  const sql: string[] = [];
  for (const app of ['app_a', 'app_b']) {
    sql.push(
      `INSERT INTO "tenants" ("id", "name", "owner_email", "updated_at") VALUES (${q(`t_${app}`)}, ${q(app)}, ${q(`${app}@example.com`)}, now())`,
      `INSERT INTO "applications" ("id", "tenant_id", "name", "slug", "public_key", "auth_config", "billing_config", "updated_at")
       VALUES (${q(app)}, ${q(`t_${app}`)}, ${q(app)}, ${q(app)}, ${q(`pk_${app}`)}, '{}'::jsonb, '{}'::jsonb, now())`,
    );
  }
  const a = seedFor('app_a');
  const b = seedFor('app_b');

  a.plan('pl_usd', 2000, 'usd', { metadata: { stripe: { priceId: 'price_1', mode: 'live' }, paypal: { planId: 'P-1' }, features: { seats: 5 } }, status: 'REGISTERED' });
  a.plan('pl_free', 0, 'USD');
  a.plan('pl_metered', 0, 'USD', { perUnit: 5, kind: 'USAGE' });
  a.plan('pl_credit', 500, 'USD', { kind: 'CREDIT' });
  a.plan('pl_stray', 2000, 'USD', { metadata: { stripe: { priceId: 'price_stray_plan' } } });
  a.plan('pl_same', 900, 'EUR', { metadata: { razorpay: { planId: 'plan_rzp' } } });
  a.plan('pl_case', 1000, 'USD');
  a.plan('pl_bad', 500, 'USDT');
  b.plan('pl_b', 3000, 'USD');

  // Filed under the wrong Application, in lower case twice over, and at an amount the plan no longer charges.
  a.price('pp_inr', 'pl_usd', 'INR', 149900, { application: 'app_b', metadata: { razorpay: { planId: 'plan_inr' } } });
  a.price('pp_stray', 'pl_stray', 'USD', 1500);
  a.price('pp_same', 'pl_same', 'EUR', 900);
  a.price('pp_case_inr', 'pl_case', 'inr', 50000);
  a.price('pp_case_gbp', 'pl_case', 'GBP', 800);
  a.price('pp_case_gbp_lower', 'pl_case', 'gbp', 800, { createdAt: '2026-10-09T12:00:00Z' });

  a.subscription('sub_default', { plan: 'pl_usd', currency: 'USD', unitAmount: 1900, provider: 'stripe' });
  a.subscription('sub_inr', { plan: 'pl_usd', currency: 'inr', unitAmount: 149900 });
  a.subscription('sub_grant', { plan: 'pl_usd' });
  a.subscription('sub_pending', { plan: 'pl_usd', status: 'PENDING' });
  a.subscription('sub_zero', { plan: 'pl_usd', currency: 'USD', unitAmount: 0 });
  a.subscription('sub_zero_eur', { plan: 'pl_usd', currency: 'EUR', unitAmount: 0 });
  a.subscription('sub_orphan', { plan: 'pl_usd', currency: 'GBP', unitAmount: 1600 });
  a.subscription('sub_orphan_lower', { plan: 'pl_usd', currency: 'gbp', unitAmount: 1500 });
  a.subscription('sub_badcur', { plan: 'pl_usd', currency: 'US$', unitAmount: 700 });
  a.subscription('sub_free', { plan: 'pl_free', currency: 'USD', unitAmount: 0 });
  a.subscription('sub_metered', { plan: 'pl_metered', currency: 'USD', unitAmount: 0 });
  a.subscription('sub_on_bad', { plan: 'pl_bad' });
  a.subscription('sub_stray', { plan: 'pl_stray', currency: 'USD', unitAmount: 1500, planPriceId: 'pp_stray', provider: 'paypal' });
  a.subscription('sub_lost', { plan: 'pl_same', planPriceId: 'pp_same' });
  a.subscription('sub_rzp', { plan: 'pl_case', currency: 'USD', unitAmount: 1000, provider: 'razorpay' });
  a.subscription('sub_checkout', { plan: 'pl_case', status: 'CANCELED' });
  // A paying Razorpay subscriber in dollars, with no payment row at all.
  b.subscription('sub_b', { plan: 'pl_b', currency: 'USD', unitAmount: 3000, provider: 'razorpay' });

  a.payment('pay_match', { subscription: 'sub_default', amount: 1900, currency: 'usd', status: 'SUCCEEDED' });
  a.payment('pay_discounted', { subscription: 'sub_default', amount: 1500, status: 'SUCCEEDED' });
  a.payment('pay_failed', { subscription: 'sub_default', amount: 1900, status: 'FAILED' });
  a.payment('pay_refunded', { subscription: 'sub_default', amount: 1900, status: 'PARTIALLY_REFUNDED', refundedAmount: 400, metadata: { refundEvents: ['evt_1'] } });
  a.payment('pay_foreign', { subscription: 'sub_default', amount: 100, currency: 'INR', status: 'SUCCEEDED' });
  a.payment('pay_loose', { amount: 2500, status: 'SUCCEEDED' });
  a.payment('pay_open_case', { amount: 2500, status: 'SUCCEEDED' });
  a.unapplied('up_open', 'pay_open_case', 'paypal', 'OPEN');
  a.payment('pay_case_refunded', { amount: 2000, status: 'REFUNDED', refundedAmount: 2000 });
  a.unapplied('up_refunded', 'pay_case_refunded', 'stripe', 'REFUNDED', { refundId: 're_1', note: 'Charged twice' });
  a.payment('pay_legacy_refunded', { amount: 2000, status: 'REFUNDED' });
  a.payment('pay_rzp_sgd', { subscription: 'sub_rzp', amount: 1400, currency: 'SGD', status: 'SUCCEEDED' });
  a.payment('pay_pp_brl', { subscription: 'sub_checkout', amount: 5000, currency: 'BRL', status: 'SUCCEEDED' });

  a.session('cs_one_time', 'sub_default', { kind: 'ONE_TIME', metadata: { expectedCharge: { amount: 1500, currency: 'USD' }, discountAmount: 500 } });
  a.session('cs_recurring', 'sub_default', { kind: 'RECURRING', currency: 'USD', unitAmount: 2000, metadata: { discountAmount: 300 } });
  a.session('cs_redirect', 'sub_default', { kind: 'RECURRING', currency: 'USD', unitAmount: 2000 });
  a.session('cs_too_large', 'sub_default', { kind: 'ONE_TIME', metadata: { expectedCharge: { amount: 12345678901 } } });
  a.session('cs_paypal', 'sub_checkout', { kind: 'RECURRING', provider: 'paypal', status: 'COMPLETE' });

  a.coupon('c_fixed', 'AMOUNT', 500, 'usd');
  a.coupon('c_no_currency', 'AMOUNT', 500, null);
  a.coupon('c_percent', 'PERCENT', 1000, 'USD');
  a.coupon('c_bad', 'AMOUNT', 500, 'USDT');
  b.coupon('c_b', 'AMOUNT', 700, 'EUR');

  a.credentials('stripe', '{EUR}');
  a.credentials('paypal', '{}');
  a.credentials('razorpay', '{}');
  a.credentials('external', '{}');
  b.credentials('stripe', '{}');
  b.credentials('paypal', null);
  b.credentials('razorpay', '{}');
  b.credentials('external', null);
  // A module this release does not ship: the migration cannot know its list.
  b.credentials('mollie', '{}');

  a.ledger('cl_direct', 'purchase:pay_match');
  a.ledger('cl_case', 'purchase:ent:sub_default:CREDIT:base:unapplied:up_open');
  a.ledger('cl_session', 'purchase:ent:sub_default:CREDIT:base:cs_test_1');
  b.ledger('cl_across', 'purchase:pay_match');

  return [...sql, ...a.sql, ...b.sql];
}

/** Money in currencies this release rescales: the deploy must refuse while these exist. */
const RESCALED_ROWS = [
  `INSERT INTO "plans" ("id", "application_id", "slug", "name", "amount", "currency", "metadata", "updated_at")
   VALUES ('pl_huf', 'app_b', 'pl_huf', 'pl_huf', 5000, 'HUF', '{"paypal": {"planId": "P-HUF"}}'::jsonb, now())`,
  `INSERT INTO "payments" ("id", "application_id", "subscription_id", "amount", "currency", "status", "updated_at")
   VALUES ('pay_twd', 'app_b', 'sub_b', 5000, 'twd', 'SUCCEEDED', now())`,
];

describe('money model migrations, in order over old rows', () => {
  let db: PrismaClient;
  let workdir: string;
  let preflightBefore: Array<Array<Record<string, unknown>>>;
  let refusal: string;
  let columnsAfterRefusal: number;

  const rows = <T = Record<string, unknown>>(sql: string) => db.$queryRawUnsafe<T[]>(sql);
  const one = async <T = Record<string, unknown>>(sql: string): Promise<T> => {
    const found = await rows<T>(sql);
    if (found.length !== 1) throw new Error(`expected one row, got ${found.length}: ${sql}`);
    return found[0]!;
  };
  const subscription = (id: string) =>
    one<{ plan_price_id: string | null; currency: string | null; unit_amount: number | null }>(
      `SELECT "plan_price_id", "currency", "unit_amount" FROM "subscriptions" WHERE "id" = ${q(id)}`,
    );
  const planRow = (id: string) =>
    one<{ default_price_id: string | null; is_free: boolean; local_prices: string; amount: number; currency: string }>(
      `SELECT "default_price_id", "is_free", "local_prices"::text, "amount", "currency" FROM "plans" WHERE "id" = ${q(id)}`,
    );
  const priceRow = (id: string) =>
    one<{ id: string; application_id: string; plan_id: string; currency: string; amount: number; archived: boolean; metadata: unknown; registration_status: string }>(
      `SELECT "id", "application_id", "plan_id", "currency", "amount", "archived_at" IS NOT NULL AS "archived", "metadata", "registration_status"::text FROM "plan_prices" WHERE "id" = ${q(id)}`,
    );
  const defaultPriceOf = async (plan: string) => priceRow((await planRow(plan)).default_price_id!);
  const payment = (id: string) =>
    one<{ plan_price_id: string | null; unit_amount: number | null; provider: string | null; verification: string; currency: string }>(
      `SELECT "plan_price_id", "unit_amount", "provider", "verification"::text, "currency" FROM "payments" WHERE "id" = ${q(id)}`,
    );
  const currenciesOf = async (application: string, provider: string) =>
    (await one<{ currencies: string[] | null }>(
      `SELECT "currencies" FROM "billing_credentials" WHERE "application_id" = ${q(application)} AND "provider" = ${q(provider)}`,
    )).currencies;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${DATABASE}"`);
    workdir = mkdtempSync(path.join(os.tmpdir(), 'rekey-mv2-'));
    cpSync(SCHEMA, path.join(workdir, 'schema.prisma'));
    cpSync(path.join(MIGRATIONS, 'migration_lock.toml'), path.join(workdir, 'migrations/migration_lock.toml'));
    for (const name of readdirSync(MIGRATIONS)) {
      if (name < FIRST && !name.endsWith('.toml')) cpSync(path.join(MIGRATIONS, name), path.join(workdir, 'migrations', name), { recursive: true });
    }
    prismaCli(['migrate', 'deploy', '--schema', path.join(workdir, 'schema.prisma')]);

    db = new PrismaClient({ datasourceUrl: databaseUrl() });
    for (const statement of [...oldRows(), ...RESCALED_ROWS]) await db.$executeRawUnsafe(statement);

    preflightBefore = [];
    for (const query of statementsOf(readFileSync(path.join(SPECS, 'billing-money-model.preflight.sql'), 'utf8'))) {
      preflightBefore.push(await rows(query));
    }

    refusal = await Promise.resolve()
      .then(() => prismaCli(['migrate', 'deploy', '--schema', SCHEMA]))
      .then(
        () => 'the deploy was not refused',
        (err: Error) => err.message,
      );
    columnsAfterRefusal = (
      await rows(`SELECT 1 FROM information_schema.columns WHERE "table_name" = 'plans' AND "column_name" = 'default_price_id'`)
    ).length;

    await db.$executeRawUnsafe(`DELETE FROM "payments" WHERE "id" = 'pay_twd'`);
    await db.$executeRawUnsafe(`DELETE FROM "plans" WHERE "id" = 'pl_huf'`);
    prismaCli(['migrate', 'resolve', '--rolled-back', FIRST, '--schema', SCHEMA]);
    prismaCli(['migrate', 'deploy', '--schema', SCHEMA]);
  }, 180_000);

  afterAll(async () => {
    await db?.$disconnect();
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    if (workdir !== undefined) rmSync(workdir, { recursive: true, force: true });
  });

  describe('the preflight', () => {
    // In file order: 1, 2, 3, 3b, 4, 5, 6, 7, 8, 9, 10, 11, 12.
    const RESCALED_QUERY = 2;
    const MALFORMED_QUERY = 10;
    const PRICE_ROWS_QUERY = 11;
    const OTHER_PLAN_QUERY = 12;

    it('only reads', () => {
      const sql = statementsOf(readFileSync(path.join(SPECS, 'billing-money-model.preflight.sql'), 'utf8'));
      expect(sql).toHaveLength(13);
      for (const query of sql) {
        expect(query).toMatch(/^SELECT\b/);
        expect(query).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|COPY|CALL|DO)\b/);
      }
    });

    it('runs on the schema as it is before the migrations, and lists every row in a rescaled currency with its provider', () => {
      expect(preflightBefore[RESCALED_QUERY]).toEqual([
        expect.objectContaining({ source: 'payments', id: 'pay_twd', application_id: 'app_b', provider: 'razorpay', currency: 'twd', amount: 5000 }),
        expect.objectContaining({ source: 'plans', id: 'pl_huf', application_id: 'app_b', provider: 'paypal', currency: 'HUF', amount: 5000 }),
      ]);
    });

    it('lists the currencies no backfill will copy, and the price rows the default-price backfill will change', () => {
      expect(preflightBefore[MALFORMED_QUERY]!.map((row) => [row.source, row.id])).toEqual([
        ['coupons', 'c_bad'],
        ['plans', 'pl_bad'],
        ['subscriptions', 'sub_badcur'],
      ]);
      expect(preflightBefore[PRICE_ROWS_QUERY]!.map((row) => row.id).sort()).toEqual(['pp_case_gbp_lower', 'pp_case_inr', 'pp_inr', 'pp_stray']);
      expect(preflightBefore[OTHER_PLAN_QUERY]).toEqual([]);
    });
  });

  describe('money in a currency this release rescales', () => {
    it('stops the deploy before anything changes, naming each table and its count and what to do', () => {
      expect(refusal).toContain('Rows found: payments (1), plans (1).');
      expect(refusal).toContain('billing-money-model.preflight.sql');
      expect(refusal).toContain(`prisma migrate resolve --rolled-back ${FIRST}`);
      expect(columnsAfterRefusal).toBe(0);
    });

    const guard = () => /DO \$\$[\s\S]*?\$\$;/.exec(migrationSql('money_v2_01_plan_default_price'))![0];
    const offending: Array<[table: string, insert: (currency: string) => string]> = [
      ['plans', (currency) => `INSERT INTO "plans" ("id", "application_id", "slug", "name", "amount", "currency", "updated_at") VALUES ('g_plan', 'app_a', 'g_plan', 'g', 1, ${q(currency)}, now())`],
      ['plan_prices', (currency) => `INSERT INTO "plan_prices" ("id", "application_id", "plan_id", "currency", "amount", "updated_at") VALUES ('g_price', 'app_a', 'pl_free', ${q(currency.toUpperCase())}, 1, now())`],
      ['subscriptions', (currency) => `UPDATE "subscriptions" SET "currency" = ${q(currency)}, "unit_amount" = 1 WHERE "id" = 'sub_pending'`],
      ['payments', (currency) => `INSERT INTO "payments" ("id", "application_id", "amount", "currency", "updated_at") VALUES ('g_pay', 'app_a', 1, ${q(currency)}, now())`],
      ['checkout_sessions', (currency) => `UPDATE "checkout_sessions" SET "currency" = ${q(currency)} WHERE "id" = 'cs_redirect'`],
      ['coupons', (currency) => `INSERT INTO "coupons" ("id", "application_id", "code", "discount_type", "amount_off", "currency", "updated_at") VALUES ('g_coupon', 'app_a', 'g', 'AMOUNT', 1, ${q(currency)}, now())`],
    ];

    it.each(offending)('refuses a row in %s, in any case, for each of the five currencies', async (table, insert) => {
      for (const currency of [...RESCALED, 'huf']) {
        const attempt = db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(insert(currency));
          await tx.$executeRawUnsafe(guard());
        });
        await expect(attempt, `${table} in ${currency}`).rejects.toThrow(`Rows found: ${table} (1).`);
      }
    });

    it('lets through a free plan and a percentage coupon in those currencies, which hold no money', async () => {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`INSERT INTO "plans" ("id", "application_id", "slug", "name", "amount", "currency", "updated_at") VALUES ('g_free', 'app_a', 'g_free', 'g', 0, 'HUF', now())`);
        await tx.$executeRawUnsafe(`INSERT INTO "coupons" ("id", "application_id", "code", "discount_type", "amount_off", "currency", "updated_at") VALUES ('g_pct', 'app_a', 'g_pct', 'PERCENT', 1000, 'HUF', now())`);
        await tx.$executeRawUnsafe(guard());
        await tx.$executeRawUnsafe(`DELETE FROM "plans" WHERE "id" = 'g_free'`);
        await tx.$executeRawUnsafe(`DELETE FROM "coupons" WHERE "id" = 'g_pct'`);
      });
    });
  });

  describe('plans and prices', () => {
    it('gives each paid plan a default price at its amount, in upper case, with its registrations', async () => {
      expect(await defaultPriceOf('pl_usd')).toMatchObject({
        application_id: 'app_a',
        currency: 'USD',
        amount: 2000,
        archived: false,
        metadata: { stripe: { priceId: 'price_1', mode: 'live' }, paypal: { planId: 'P-1' } },
        registration_status: 'REGISTERED',
      });
      expect(await planRow('pl_usd')).toMatchObject({ amount: 2000, currency: 'usd' });
      expect(await defaultPriceOf('pl_b')).toMatchObject({ application_id: 'app_b', currency: 'USD', amount: 3000 });
    });

    it('archives a price in the plan currency at another amount, and adopts one at the plan amount', async () => {
      const stray = await defaultPriceOf('pl_stray');
      expect(stray).toMatchObject({ amount: 2000, archived: false, metadata: { stripe: { priceId: 'price_stray_plan' } } });
      expect(stray.id).not.toBe('pp_stray');
      expect(await priceRow('pp_stray')).toMatchObject({ amount: 1500, archived: true, metadata: {} });
      expect(await defaultPriceOf('pl_same')).toMatchObject({ id: 'pp_same', metadata: { razorpay: { planId: 'plan_rzp' } } });
    });

    it('upper-cases a stored price currency, keeps one live per currency, and files each price under its plan Application', async () => {
      expect(await priceRow('pp_case_inr')).toMatchObject({ currency: 'INR', archived: false });
      expect(await priceRow('pp_case_gbp')).toMatchObject({ currency: 'GBP', archived: false });
      expect(await priceRow('pp_case_gbp_lower')).toMatchObject({ currency: 'GBP', archived: true });
      expect(await priceRow('pp_inr')).toMatchObject({ application_id: 'app_a', archived: false });
      expect(await rows(`SELECT 1 FROM "plan_prices" AS pp JOIN "plans" AS p ON p."id" = pp."plan_id" WHERE pp."application_id" <> p."application_id"`)).toEqual([]);
      expect(await rows(`SELECT 1 FROM "plan_prices" WHERE "currency" !~ '^[A-Z]{3}$'`)).toEqual([]);
    });

    it('leaves a plan whose currency is not three letters without a price', async () => {
      expect(await planRow('pl_bad')).toMatchObject({ default_price_id: null, currency: 'USDT' });
      expect(await rows(`SELECT 1 FROM "plan_prices" WHERE "plan_id" = 'pl_bad'`)).toEqual([]);
    });

    it('flags every plan that exists as free or not, and starts credit plans on trusted local prices', async () => {
      const flags = await rows<{ id: string; is_free: boolean }>(`SELECT "id", "is_free" FROM "plans" ORDER BY "id"`);
      expect(Object.fromEntries(flags.map((row) => [row.id, row.is_free]))).toEqual({
        pl_b: false,
        pl_bad: false,
        pl_case: false,
        pl_credit: false,
        pl_free: true,
        pl_metered: false,
        pl_same: false,
        pl_stray: false,
        pl_usd: false,
      });
      expect(await planRow('pl_free')).toMatchObject({ default_price_id: null });
      expect(await planRow('pl_metered')).toMatchObject({ default_price_id: null });
      expect(await planRow('pl_credit')).toMatchObject({ local_prices: 'TRUSTED' });
      expect(await planRow('pl_usd')).toMatchObject({ local_prices: 'INHERIT' });
    });

    it('refuses a new price whose currency is not three upper-case letters', async () => {
      const insert = (currency: string) =>
        db.$executeRawUnsafe(
          `INSERT INTO "plan_prices" ("id", "application_id", "plan_id", "currency", "amount", "updated_at") VALUES (${q(`pp_new_${currency}`)}, 'app_a', 'pl_free', ${q(currency)}, 100, now())`,
        );
      for (const currency of ['usd', 'USDT', 'US', 'U$D', 'ÜSD']) await expect(insert(currency), currency).rejects.toThrow(/plan_prices_currency_code/);
      await insert('JPY');
      await db.$executeRawUnsafe(`DELETE FROM "plan_prices" WHERE "id" = 'pp_new_JPY'`);
    });
  });

  describe('subscriptions', () => {
    it('names the price each subscription pays without changing what it pays', async () => {
      const usd = (await planRow('pl_usd')).default_price_id;
      expect(await subscription('sub_default')).toEqual({ plan_price_id: usd, currency: 'USD', unit_amount: 1900 });
      expect(await subscription('sub_inr')).toEqual({ plan_price_id: 'pp_inr', currency: 'inr', unit_amount: 149900 });
      expect(await subscription('sub_grant')).toEqual({ plan_price_id: usd, currency: 'USD', unit_amount: 2000 });
      expect(await subscription('sub_stray')).toEqual({ plan_price_id: 'pp_stray', currency: 'USD', unit_amount: 1500 });
      expect(await subscription('sub_lost')).toEqual({ plan_price_id: 'pp_same', currency: 'EUR', unit_amount: 900 });
      expect(await subscription('sub_b')).toEqual({ plan_price_id: (await planRow('pl_b')).default_price_id, currency: 'USD', unit_amount: 3000 });

      const orphan = await subscription('sub_orphan');
      expect(orphan).toMatchObject({ currency: 'GBP', unit_amount: 1600 });
      expect(await priceRow(orphan.plan_price_id!)).toMatchObject({ plan_id: 'pl_usd', application_id: 'app_a', currency: 'GBP', amount: 1600, archived: true });
      expect(await subscription('sub_orphan_lower')).toEqual({ plan_price_id: orphan.plan_price_id, currency: 'gbp', unit_amount: 1500 });
    });

    it('keeps a subscriber who pays nothing on a paid plan at nothing, and un-prices one on a plan that charges nothing', async () => {
      const usd = (await planRow('pl_usd')).default_price_id;
      expect(await subscription('sub_zero')).toEqual({ plan_price_id: usd, currency: 'USD', unit_amount: 0 });
      expect(await subscription('sub_zero_eur')).toEqual({ plan_price_id: usd, currency: 'USD', unit_amount: 0 });
      const none = { plan_price_id: null, currency: null, unit_amount: null };
      expect(await subscription('sub_free')).toEqual(none);
      expect(await subscription('sub_metered')).toEqual(none);
      expect(await subscription('sub_pending')).toEqual(none);
      expect(await subscription('sub_on_bad')).toEqual(none);
    });

    it('links every subscription to a price of its own plan, and leaves only a malformed currency unlinked', async () => {
      expect(await rows(`SELECT s."id" FROM "subscriptions" AS s JOIN "plan_prices" AS pp ON pp."id" = s."plan_price_id" WHERE pp."plan_id" <> s."plan_id" OR pp."application_id" <> s."application_id"`)).toEqual([]);
      expect(await rows(`SELECT "id" FROM "subscriptions" WHERE ("currency" IS NULL) <> ("plan_price_id" IS NULL)`)).toEqual([{ id: 'sub_badcur' }]);
      expect(await subscription('sub_badcur')).toEqual({ plan_price_id: null, currency: 'US$', unit_amount: 700 });
    });

    it('still takes what the previous API writes: a price with no price row, and a price row deleted from under a subscription', async () => {
      await db.$executeRawUnsafe(`UPDATE "subscriptions" SET "currency" = 'USD', "unit_amount" = 2000 WHERE "id" = 'sub_pending'`);
      expect(await subscription('sub_pending')).toEqual({ plan_price_id: null, currency: 'USD', unit_amount: 2000 });
      await db.$executeRawUnsafe(`UPDATE "subscriptions" SET "currency" = NULL, "unit_amount" = NULL WHERE "id" = 'sub_pending'`);

      const undo = new Error('undo the delete');
      const deleted = db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`DELETE FROM "plan_prices" WHERE "id" = 'pp_inr'`);
        const left = await tx.$queryRawUnsafe(`SELECT "plan_price_id", "currency" FROM "subscriptions" WHERE "id" = 'sub_inr'`);
        expect(left).toEqual([{ plan_price_id: null, currency: 'inr' }]);
        throw undo;
      });
      await expect(deleted).rejects.toBe(undo);
      expect((await subscription('sub_inr')).plan_price_id).toBe('pp_inr');
    });
  });

  describe('payments, refunds and credit purchases', () => {
    it('says which price a payment was for, who took it and whether it was matched, only where a row can prove it', async () => {
      const usd = (await planRow('pl_usd')).default_price_id;
      expect(await payment('pay_match')).toEqual({ plan_price_id: usd, unit_amount: 1900, provider: 'stripe', verification: 'VERIFIED', currency: 'usd' });
      expect(await payment('pay_discounted')).toMatchObject({ plan_price_id: usd, unit_amount: null, provider: 'stripe' });
      expect(await payment('pay_refunded')).toMatchObject({ plan_price_id: usd, unit_amount: 1900 });
      expect(await payment('pay_failed')).toMatchObject({ plan_price_id: null, unit_amount: null, provider: 'stripe' });
      expect(await payment('pay_foreign')).toMatchObject({ plan_price_id: null, unit_amount: null });
      expect(await payment('pay_loose')).toMatchObject({ plan_price_id: null, provider: null, verification: 'VERIFIED' });
      expect(await payment('pay_open_case')).toMatchObject({ plan_price_id: null, provider: 'paypal', verification: 'UNVERIFIED' });
      expect(await payment('pay_case_refunded')).toMatchObject({ provider: 'stripe', verification: 'VERIFIED' });
    });

    it('turns a refunded total into one refund row', async () => {
      const refunds = await rows(
        `SELECT "payment_id", "application_id", "amount", "currency", "status"::text, "initiated_by"::text, "provider_refund_id", "reason", "created_at" FROM "refunds" ORDER BY "payment_id"`,
      );
      expect(refunds).toEqual([
        {
          payment_id: 'pay_case_refunded',
          application_id: 'app_a',
          amount: 2000,
          currency: 'USD',
          status: 'SUCCEEDED',
          initiated_by: 'OPERATOR',
          provider_refund_id: 're_1',
          reason: 'Charged twice',
          created_at: new Date('2026-09-20T09:00:00.000Z'),
        },
        {
          payment_id: 'pay_refunded',
          application_id: 'app_a',
          amount: 400,
          currency: 'USD',
          status: 'SUCCEEDED',
          initiated_by: 'PROVIDER',
          provider_refund_id: null,
          reason: null,
          created_at: new Date('2026-09-15T08:00:00.000Z'),
        },
      ]);
    });

    it('names the payment on a credit purchase whose key says which one, inside its own Application', async () => {
      const usd = (await planRow('pl_usd')).default_price_id;
      const ledger = await rows<{ id: string; payment_id: string | null; plan_price_id: string | null }>(
        `SELECT "id", "payment_id", "plan_price_id" FROM "credit_ledger" ORDER BY "id"`,
      );
      expect(ledger).toEqual([
        { id: 'cl_across', payment_id: null, plan_price_id: null },
        { id: 'cl_case', payment_id: 'pay_open_case', plan_price_id: null },
        { id: 'cl_direct', payment_id: 'pay_match', plan_price_id: usd },
        { id: 'cl_session', payment_id: null, plan_price_id: null },
      ]);
    });
  });

  describe('checkouts, coupons and provider currencies', () => {
    it('copies what a checkout was to charge, and derives it for a recurring checkout that recorded its discount', async () => {
      const sessions = await rows<{ id: string; charge_amount: number | null; discount_amount: number | null }>(
        `SELECT "id", "charge_amount", "discount_amount" FROM "checkout_sessions" ORDER BY "id"`,
      );
      expect(sessions).toEqual([
        { id: 'cs_one_time', charge_amount: 1500, discount_amount: 500 },
        { id: 'cs_paypal', charge_amount: null, discount_amount: null },
        { id: 'cs_recurring', charge_amount: 1700, discount_amount: 300 },
        { id: 'cs_redirect', charge_amount: null, discount_amount: null },
        { id: 'cs_too_large', charge_amount: null, discount_amount: null },
      ]);
    });

    it('gives each fixed coupon one amount in its own currency and Application', async () => {
      expect(await rows(`SELECT "coupon_id", "application_id", "currency", "amount_off" FROM "coupon_amounts" ORDER BY "coupon_id"`)).toEqual([
        { coupon_id: 'c_b', application_id: 'app_b', currency: 'EUR', amount_off: 700 },
        { coupon_id: 'c_fixed', application_id: 'app_a', currency: 'USD', amount_off: 500 },
      ]);
    });

    it('fills each empty provider list from its defaults and what that Application has sold in, and no other', async () => {
      expect(await currenciesOf('app_a', 'stripe')).toEqual(['EUR']);
      const external = await currenciesOf('app_a', 'external');
      expect(external!.length).toBeGreaterThan(100);
      expect(external).toEqual(expect.arrayContaining(['USD', 'INR', 'IRR']));
      expect(await currenciesOf('app_b', 'external')).toEqual(external);
      expect(await currenciesOf('app_b', 'mollie')).toEqual(external);
      expect(await currenciesOf('app_a', 'razorpay')).toEqual(['INR', 'SGD', 'USD']);
      expect(await currenciesOf('app_b', 'razorpay')).toEqual(['INR', 'USD']);
      const paypal = await currenciesOf('app_a', 'paypal');
      expect(paypal).toHaveLength(23);
      expect(paypal).toContain('BRL');
      const untouchedDefaults = await currenciesOf('app_b', 'paypal');
      expect(untouchedDefaults).toHaveLength(22);
      expect(untouchedDefaults).not.toContain('BRL');
      expect((await currenciesOf('app_b', 'stripe'))!.length).toBeGreaterThan(100);
    });

    it('leaves no provider row without a currency', async () => {
      expect(await rows(`SELECT "application_id", "provider" FROM "billing_credentials" WHERE coalesce(cardinality("currencies"), 0) = 0`)).toEqual([]);
    });
  });

  describe('the billing log', () => {
    const event = (id: string, application: string) =>
      `INSERT INTO "billing_events" ("id", "application_id", "type", "tier", "occurred_at", "dedupe_key", "actor_type") VALUES (${q(id)}, ${q(application)}, 'plan.price_set', 'PERMANENT', now(), ${q(id)}, 'SYSTEM')`;
    const count = async () => Number((await one<{ n: bigint }>(`SELECT count(*) AS "n" FROM "billing_events"`)).n);

    it('refuses a change even when a temporary table stands in for "applications"', async () => {
      await db.$executeRawUnsafe(event('ev_1', 'app_a'));
      for (const change of [`DELETE FROM "billing_events"`, `UPDATE "billing_events" SET "amount" = 1`]) {
        const attempt = db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`CREATE TEMP TABLE "applications" ("id" TEXT) ON COMMIT DROP`);
          await tx.$executeRawUnsafe(change);
        });
        await expect(attempt, change).rejects.toThrow(/append-only/);
      }
      expect(await count()).toBe(1);
    });

    it('refuses TRUNCATE while any Application remains, with or without the maintenance setting', async () => {
      for (const truncate of [`TRUNCATE "billing_events"`, `TRUNCATE "billing_events" CASCADE`, `TRUNCATE "billing_events", "billing_event_outbox" RESTART IDENTITY`]) {
        await expect(db.$executeRawUnsafe(truncate), truncate).rejects.toThrow(/append-only: TRUNCATE refused/);
      }
      const underMaintenance = db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL rekey.billing_events_maintenance = 'on'`);
        await tx.$executeRawUnsafe(`TRUNCATE "billing_events"`);
      });
      await expect(underMaintenance).rejects.toThrow(/append-only: TRUNCATE refused/);
      expect(await count()).toBe(1);
    });

    it('goes with its Application, and with its Tenant', async () => {
      for (const app of ['app_gone', 'app_of_tenant']) {
        await db.$executeRawUnsafe(`INSERT INTO "tenants" ("id", "name", "owner_email", "updated_at") VALUES (${q(`t_${app}`)}, ${q(app)}, ${q(`${app}@example.com`)}, now())`);
        await db.$executeRawUnsafe(
          `INSERT INTO "applications" ("id", "tenant_id", "name", "slug", "public_key", "auth_config", "billing_config", "updated_at") VALUES (${q(app)}, ${q(`t_${app}`)}, ${q(app)}, ${q(app)}, ${q(`pk_${app}`)}, '{}'::jsonb, '{}'::jsonb, now())`,
        );
        await db.$executeRawUnsafe(event(`ev_${app}`, app));
      }
      expect(await count()).toBe(3);

      await db.$executeRawUnsafe(`DELETE FROM "applications" WHERE "id" = 'app_gone'`);
      expect(await count()).toBe(2);
      await db.$executeRawUnsafe(`DELETE FROM "tenants" WHERE "id" = 't_app_of_tenant'`);
      expect(await count()).toBe(1);
    });
  });

  // Last: it changes the schema the tests above read.
  describe('step Z, the constraints that ship later', () => {
    const stepZ = path.join(SPECS, 'billing-money-model.step-z.sql');
    const apply = () => prismaCli(['db', 'execute', '--file', stepZ, '--schema', SCHEMA]);
    const constraints = async () =>
      (await rows<{ conname: string }>(`SELECT "conname" FROM pg_constraint WHERE "conrelid" = 'subscriptions'::regclass AND "conname" LIKE '%price%' ORDER BY 1`)).map(
        (row) => row.conname,
      );

    it('repeats the subscription backfill and the coupon rate backfill word for word, and not the provider-currency fill', () => {
      const note = statementsOf(readFileSync(stepZ, 'utf8'));
      for (const suffix of ['money_v2_06_backfill_subscription_prices', 'money_v2_41_backfill_coupon_basis_points']) {
        for (const statement of statementsOf(migrationSql(suffix))) expect(note, suffix).toContain(statement);
      }
      // An empty provider list is an operator's choice by then, and a second fill would undo it.
      expect(note.filter((statement) => statement.includes('"billing_credentials"'))).toEqual([]);
      expect(note[0]).toBe('LOCK TABLE "subscriptions" IN SHARE ROW EXCLUSIVE MODE');
    });

    it('changes nothing while a subscription cannot be priced, then constrains once it is corrected', async () => {
      const before = await constraints();
      expect(before).toEqual(['subscriptions_plan_price_id_fkey', 'subscriptions_price_pair']);
      // Written by an older unit after the foundation migrations, and a provider an operator has since left with no currency.
      await db.$executeRawUnsafe(`UPDATE "subscriptions" SET "currency" = 'USD', "unit_amount" = 2000 WHERE "id" = 'sub_pending'`);
      await db.$executeRawUnsafe(`UPDATE "billing_credentials" SET "currencies" = '{}' WHERE "application_id" = 'app_b' AND "provider" = 'razorpay'`);

      expect(apply).toThrow(/subscriptions_price_snapshot/);
      expect(await constraints()).toEqual(before);
      expect(await subscription('sub_pending')).toMatchObject({ plan_price_id: null });

      await db.$executeRawUnsafe(`UPDATE "subscriptions" SET "currency" = 'USD' WHERE "id" = 'sub_badcur'`);
      apply();

      expect(await constraints()).toEqual(['subscriptions_plan_price_id_plan_id_fkey', 'subscriptions_price_snapshot']);
      const usd = (await planRow('pl_usd')).default_price_id;
      expect(await subscription('sub_pending')).toEqual({ plan_price_id: usd, currency: 'USD', unit_amount: 2000 });
      expect(await subscription('sub_badcur')).toEqual({ plan_price_id: usd, currency: 'USD', unit_amount: 700 });
      expect(await currenciesOf('app_b', 'razorpay')).toEqual([]);

      const write = (sql: string) => db.$executeRawUnsafe(sql);
      await expect(write(`UPDATE "subscriptions" SET "plan_price_id" = NULL WHERE "id" = 'sub_default'`)).rejects.toThrow(/subscriptions_price_snapshot/);
      await expect(write(`UPDATE "subscriptions" SET "plan_price_id" = 'pp_same' WHERE "id" = 'sub_default'`)).rejects.toThrow(/subscriptions_plan_price_id_plan_id_fkey/);
      await expect(write(`DELETE FROM "plan_prices" WHERE "id" = 'pp_inr'`)).rejects.toThrow(/subscriptions_plan_price_id_plan_id_fkey/);
    });
  });
});
