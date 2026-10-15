/**
 * The money-model migrations, applied in order over old-shaped rows.
 *
 * A database migrated to just before the first money-model migration, filled
 * with awkward rows across two Applications, and then taken the rest of the
 * way with `prisma migrate deploy`, which is how production meets them. The
 * deploy is refused twice on the way: once for money in a rescaled currency,
 * once by the contract migrations for rows that cannot be migrated. The state
 * after the second refusal is what 2.2.0-rc.7 ran on, and the last block
 * takes it through the contract. It runs in a database of its own, created
 * and dropped here.
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
const SPECS = path.join(REPO, 'docs/upgrades');
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

/** The preflight file's statements by part: A (any release), B (a release candidate), C (after a contract refusal). */
function preflightParts(): { a: string[]; b: string[]; c: string[] } {
  const [, a, b, c] = readFileSync(path.join(SPECS, 'billing-money-model.preflight.sql'), 'utf8').split(/^-- =+ PART [ABC] =+$/m);
  return { a: statementsOf(a ?? ''), b: statementsOf(b ?? ''), c: statementsOf(c ?? '') };
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
  let preflightAnyRelease: Array<Array<Record<string, unknown>>>;
  let preflightAfterContractRefusal: Array<Array<Record<string, unknown>>>;
  let refusal: string;
  let contractRefusal: string;
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
    for (const query of preflightParts().b) preflightBefore.push(await rows(query));
    preflightAnyRelease = [];
    for (const query of preflightParts().a) preflightAnyRelease.push(await rows(query));

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
    // Every migration up to the contract applies. The contract's first
    // migration then refuses the rows no migration could place.
    contractRefusal = await Promise.resolve()
      .then(() => prismaCli(['migrate', 'deploy', '--schema', SCHEMA]))
      .then(
        () => 'the deploy was not refused',
        (err: Error) => err.message,
      );
    preflightAfterContractRefusal = [];
    for (const query of preflightParts().c) preflightAfterContractRefusal.push(await rows(query));
  }, 240_000);

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
      const { a, b, c } = preflightParts();
      expect([a.length, b.length, c.length]).toEqual([10, 13, 12]);
      for (const query of [...a, ...b, ...c]) {
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

    it('has a part that needs no table newer than 2.1.0, which lists the same rescaled and malformed money', () => {
      const [rescaled, malformed, badRate] = preflightAnyRelease;
      expect(rescaled!.map((row) => [row.source, row.id])).toEqual([['payments', 'pay_twd'], ['plans', 'pl_huf']]);
      expect(malformed!.map((row) => [row.source, row.id])).toEqual([['coupons', 'c_bad'], ['coupons', 'c_no_currency'], ['plans', 'pl_bad']]);
      expect(badRate).toEqual([]);
    });

    it('lists, after the contract refused, exactly the rows it refused', () => {
      const ids = preflightAfterContractRefusal.map((found) => found.map((row) => row.id).sort());
      // In file order: 13 to 24.
      expect(ids).toEqual([['sub_badcur'], ['pl_bad'], [], [], [], ['c_bad', 'c_no_currency'], [], [], [], [], [], []]);
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
  describe('the contract migrations', () => {
    const CONTRACT = readdirSync(MIGRATIONS).filter((name) => name.startsWith('20261014')).sort();
    const fileOf = (suffix: string): string => {
      const dir = CONTRACT.find((name) => name.endsWith(suffix));
      if (dir === undefined) throw new Error(`no contract migration ends with ${suffix}`);
      return path.join(MIGRATIONS, dir, 'migration.sql');
    };
    /** Run one migration file as `migrate deploy` would, and return what stopped it. */
    const refusalOf = (suffix: string): string => {
      try {
        prismaCli(['db', 'execute', '--file', fileOf(suffix), '--schema', SCHEMA]);
        return 'the file ran';
      } catch (err) {
        return (err as Error).message;
      }
    };
    const shape = async () => ({
      subscriptionConstraints: (
        await rows<{ conname: string }>(`SELECT "conname" FROM pg_constraint WHERE "conrelid" = 'subscriptions'::regclass AND "conname" LIKE '%price%' ORDER BY 1`)
      ).map((row) => row.conname),
      droppedColumns: (
        await rows<{ column: string }>(
          `SELECT "table_name" || '.' || "column_name" AS "column" FROM information_schema.columns
            WHERE ("table_name" = 'plans' AND "column_name" IN ('amount', 'currency', 'price_per_unit_cents'))
               OR ("table_name" = 'coupons' AND "column_name" IN ('amount_off', 'currency'))
               OR ("table_name" = 'tenant_users' AND "column_name" IN ('failed_sign_in_attempts', 'locked_until'))
            ORDER BY 1`,
        )
      ).map((row) => row.column),
      oldReportingKeys: Number((await one<{ n: bigint }>(`SELECT count(*) AS "n" FROM "applications" WHERE "billing_config" ? 'currency'`)).n),
    });
    const RC7_SHAPE = {
      subscriptionConstraints: ['subscriptions_plan_price_id_fkey', 'subscriptions_price_pair'],
      droppedColumns: [
        'coupons.amount_off',
        'coupons.currency',
        'plans.amount',
        'plans.currency',
        'plans.price_per_unit_cents',
        'tenant_users.failed_sign_in_attempts',
        'tenant_users.locked_until',
      ],
    };
    const defaultOf = (plan: string) => `(SELECT "default_price_id" FROM "plans" WHERE "id" = ${q(plan)})`;

    it('run the changes an earlier API version tolerates first, and the drops that break it last and together', () => {
      const drops = CONTRACT.map((name) => /DROP COLUMN/.test(readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8')));
      expect(CONTRACT.map((name) => name.replace(/^\d+_/, ''))).toEqual([
        'price_and_coupon_column_drop_checks',
        'subscription_price_snapshot_constraints',
        'currency_lists_not_null',
        'remove_billing_config_currency_key',
        'plan_prices_live_on_price_rows',
        'coupon_terms_live_on_rate_and_amount_rows',
        'drop_unused_lockout_columns',
      ]);
      expect(drops).toEqual([false, false, false, false, true, true, true]);
      // Nothing is applied after the last of them.
      expect(readdirSync(MIGRATIONS).filter((name) => !name.endsWith('.toml')).sort().at(-1)).toBe(CONTRACT.at(-1));
    });

    it('stop the deploy before anything changes, with every reason, its count and what to do in one message', async () => {
      expect(contractRefusal).toContain('20261014100001_price_and_coupon_column_drop_checks');
      expect(contractRefusal).toContain('This migration changed nothing; the migrations before it are applied.');
      expect(contractRefusal).not.toContain('Nothing was changed');
      expect(contractRefusal).toMatch(/"subscriptions": 1 row\(s\) have some of "plan_price_id", "currency" and "unit_amount" set and not the others/);
      expect(contractRefusal).toMatch(/"plans": 1 row\(s\) have an "amount" and no default price row/);
      // It says what is known of the row, not why it came to be so.
      expect(contractRefusal).not.toMatch(/their "currency" is not a three-letter code/);
      expect(contractRefusal).toMatch(/"coupons": 2 row\(s\) are fixed-amount coupons with no row in "coupon_amounts"/);
      expect(contractRefusal).toMatch(/See query 13\..*See query 14\..*See query 18\./s);
      expect(contractRefusal).toContain('docs/upgrades/billing-money-model.preflight.sql');
      expect(contractRefusal).toContain('prisma migrate resolve --rolled-back 20261014100001_price_and_coupon_column_drop_checks');
      // The reasons that do not apply are not in it.
      expect(contractRefusal).not.toMatch(/"applications"|percentage coupons|belongs to another plan|disagrees|archived|match none|pricePerUnitCents|not the currency/);
      expect(await shape()).toMatchObject(RC7_SHAPE);
    });

    it('refuse one un-migratable row of each kind twice: in the checks, and in the migration that would have met it', async () => {
      // What an operator does about the rows named above, as the preflight file shows.
      for (const mend of [
        `UPDATE "subscriptions" SET "currency" = 'USD', "plan_price_id" = ${defaultOf('pl_usd')} WHERE "id" = 'sub_badcur'`,
        `INSERT INTO "plan_prices" ("id", "application_id", "plan_id", "currency", "amount", "updated_at") VALUES ('pp_bad_by_hand', 'app_a', 'pl_bad', 'USD', 500, now())`,
        `UPDATE "plans" SET "currency" = 'USD', "default_price_id" = 'pp_bad_by_hand' WHERE "id" = 'pl_bad'`,
        `INSERT INTO "coupon_amounts" ("id", "application_id", "coupon_id", "currency", "amount_off") VALUES ('ca_by_hand', 'app_a', 'c_no_currency', 'USD', 500)`,
        `DELETE FROM "coupons" WHERE "id" = 'c_bad'`,
      ]) {
        await db.$executeRawUnsafe(mend);
      }
      expect(refusalOf('_price_and_coupon_column_drop_checks')).toBe('the file ran');

      const withoutCurrencyCheck = (change: string) => [
        `ALTER TABLE "plan_prices" DROP CONSTRAINT "plan_prices_currency_code"`,
        change,
        `ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_currency_code" CHECK ("currency" = upper("currency") AND "currency" ~ '^[A-Z]{3}$') NOT VALID`,
      ];
      const cases: Array<{ row: string; migration: string; says: RegExp; make: string[]; mend: string[] }> = [
        {
          row: 'a subscription with a currency and no price row',
          migration: '_subscription_price_snapshot_constraints',
          says: /"subscriptions": 1 row\(s\) have some of "plan_price_id", "currency" and "unit_amount" set and not the others/,
          make: [`UPDATE "subscriptions" SET "plan_price_id" = NULL WHERE "id" = 'sub_default'`],
          mend: [`UPDATE "subscriptions" SET "plan_price_id" = ${defaultOf('pl_usd')} WHERE "id" = 'sub_default'`],
        },
        {
          row: 'a subscription on a price of another plan',
          migration: '_subscription_price_snapshot_constraints',
          says: /"subscriptions": 1 row\(s\) name a price in "plan_price_id" that belongs to another plan/,
          make: [`UPDATE "subscriptions" SET "plan_price_id" = 'pp_same' WHERE "id" = 'sub_default'`],
          mend: [`UPDATE "subscriptions" SET "plan_price_id" = ${defaultOf('pl_usd')} WHERE "id" = 'sub_default'`],
        },
        {
          row: 'a plan that charges and has no price row',
          migration: '_plan_prices_live_on_price_rows',
          says: /"plans": 1 row\(s\) have an "amount" and no default price row/,
          make: [`UPDATE "plans" SET "default_price_id" = NULL WHERE "id" = 'pl_b'`],
          mend: [`UPDATE "plans" SET "default_price_id" = (SELECT "id" FROM "plan_prices" WHERE "plan_id" = 'pl_b' AND "archived_at" IS NULL) WHERE "id" = 'pl_b'`],
        },
        {
          row: 'a plan whose amount is not its price row',
          migration: '_plan_prices_live_on_price_rows',
          says: /"plans": 1 row\(s\) have an "amount" or "currency" that disagrees with their default price row/,
          make: [`UPDATE "plans" SET "amount" = 3100 WHERE "id" = 'pl_b'`],
          mend: [`UPDATE "plans" SET "amount" = 3000 WHERE "id" = 'pl_b'`],
        },
        {
          row: 'a priced plan flagged free',
          migration: '_plan_prices_live_on_price_rows',
          says: /"plans": 1 row\(s\) have an "is_free" flag that disagrees/,
          make: [`UPDATE "plans" SET "is_free" = true WHERE "id" = 'pl_b'`],
          mend: [`UPDATE "plans" SET "is_free" = false WHERE "id" = 'pl_b'`],
        },
        {
          row: 'a price in a currency that is not a code',
          migration: '_plan_prices_live_on_price_rows',
          says: /"plan_prices": 1 row\(s\) have a "currency" that is not three upper-case letters/,
          make: withoutCurrencyCheck(`UPDATE "plan_prices" SET "currency" = 'rupees' WHERE "id" = 'pp_case_inr'`),
          mend: [`UPDATE "plan_prices" SET "currency" = 'INR' WHERE "id" = 'pp_case_inr'`],
        },
        {
          row: 'a percentage coupon with no rate',
          migration: '_coupon_terms_live_on_rate_and_amount_rows',
          says: /"coupons": 1 row\(s\) are percentage coupons with no rate in "basis_points"/,
          make: [`UPDATE "coupons" SET "basis_points" = NULL WHERE "id" = 'c_percent'`],
          mend: [`UPDATE "coupons" SET "basis_points" = 1000 WHERE "id" = 'c_percent'`],
        },
        {
          row: 'a fixed coupon whose amount is only in the column being dropped',
          migration: '_coupon_terms_live_on_rate_and_amount_rows',
          says: /"coupons": 1 row\(s\) are fixed-amount coupons with no row in "coupon_amounts"/,
          make: [`DELETE FROM "coupon_amounts" WHERE "coupon_id" = 'c_fixed'`],
          mend: [`INSERT INTO "coupon_amounts" ("id", "application_id", "coupon_id", "currency", "amount_off") VALUES ('ca_back', 'app_a', 'c_fixed', 'USD', 500)`],
        },
        {
          row: 'a subscription in another currency than the price row it names',
          migration: '_subscription_price_snapshot_constraints',
          says: /"subscriptions": 1 row\(s\) record a "currency" that is not the currency of the price row they name/,
          make: [`UPDATE "subscriptions" SET "currency" = 'EUR' WHERE "id" = 'sub_default'`],
          mend: [`UPDATE "subscriptions" SET "currency" = 'USD' WHERE "id" = 'sub_default'`],
        },
        {
          row: 'a plan whose currency is not its price row currency',
          migration: '_plan_prices_live_on_price_rows',
          says: /"plans": 1 row\(s\) have an "amount" or "currency" that disagrees with their default price row/,
          make: [`UPDATE "plans" SET "currency" = 'EUR' WHERE "id" = 'pl_b'`],
          mend: [`UPDATE "plans" SET "currency" = 'USD' WHERE "id" = 'pl_b'`],
        },
        {
          row: 'a plan at amount 0 that still has a default price',
          migration: '_plan_prices_live_on_price_rows',
          says: /"plans": 1 row\(s\) have an "amount" or "currency" that disagrees with their default price row.*set "default_price_id" to NULL/,
          make: [`UPDATE "plans" SET "amount" = 0 WHERE "id" = 'pl_b'`],
          mend: [`UPDATE "plans" SET "amount" = 3000 WHERE "id" = 'pl_b'`],
        },
        {
          row: 'a plan whose default price row is archived',
          migration: '_plan_prices_live_on_price_rows',
          says: /"plans": 1 row\(s\) have a default price row that is archived.*un-archive it/,
          make: [`UPDATE "plan_prices" SET "archived_at" = now() WHERE "id" = ${defaultOf('pl_b')}`],
          mend: [`UPDATE "plan_prices" SET "archived_at" = NULL WHERE "id" = ${defaultOf('pl_b')}`],
        },
        {
          row: 'a plan with a negative amount and no price row',
          migration: '_plan_prices_live_on_price_rows',
          says: /"plans": 1 row\(s\) have an "amount" and no default price row/,
          make: [`UPDATE "plans" SET "amount" = -5, "default_price_id" = NULL WHERE "id" = 'pl_free'`, `UPDATE "plans" SET "is_free" = false WHERE "id" = 'pl_free'`],
          mend: [`UPDATE "plans" SET "amount" = 0, "is_free" = true WHERE "id" = 'pl_free'`],
        },
        {
          row: 'a per-unit price on a plan whose metadata is not an object',
          migration: '_plan_prices_live_on_price_rows',
          says: /"plans": 1 row\(s\) have a "price_per_unit_cents" that cannot be kept under "pricePerUnitCents" in "metadata"/,
          make: [`UPDATE "plans" SET "metadata" = '[]'::jsonb, "price_per_unit_cents" = 3 WHERE "id" = 'pl_b'`],
          mend: [`UPDATE "plans" SET "metadata" = '{}'::jsonb, "price_per_unit_cents" = NULL WHERE "id" = 'pl_b'`],
        },
        {
          row: 'a per-unit price beside a different one already in the metadata',
          migration: '_plan_prices_live_on_price_rows',
          says: /"plans": 1 row\(s\) have a "price_per_unit_cents" that cannot be kept under "pricePerUnitCents" in "metadata"/,
          make: [`UPDATE "plans" SET "metadata" = '{"pricePerUnitCents": 9}'::jsonb, "price_per_unit_cents" = 3 WHERE "id" = 'pl_b'`],
          mend: [`UPDATE "plans" SET "metadata" = '{}'::jsonb, "price_per_unit_cents" = NULL WHERE "id" = 'pl_b'`],
        },
        {
          row: 'a fixed coupon that carries a rate',
          migration: '_coupon_terms_live_on_rate_and_amount_rows',
          says: /"coupons": 1 row\(s\) are percentage coupons with no rate in "basis_points" from 0 to 10000, or fixed-amount coupons that have one/,
          make: [`UPDATE "coupons" SET "basis_points" = 500 WHERE "id" = 'c_fixed'`],
          mend: [`UPDATE "coupons" SET "basis_points" = NULL WHERE "id" = 'c_fixed'`],
        },
        {
          row: 'a fixed coupon whose own amount is in none of its amount rows',
          migration: '_coupon_terms_live_on_rate_and_amount_rows',
          says: /"coupons": 1 row\(s\) are fixed-amount coupons whose "amount_off" and "currency" match none of their rows in "coupon_amounts"/,
          make: [`UPDATE "coupons" SET "amount_off" = 900, "currency" = 'GBP' WHERE "id" = 'c_fixed'`],
          mend: [`UPDATE "coupons" SET "amount_off" = 500, "currency" = 'usd' WHERE "id" = 'c_fixed'`],
        },
        {
          row: 'a percentage coupon with two different rates',
          migration: '_coupon_terms_live_on_rate_and_amount_rows',
          says: /"coupons": 1 row\(s\) are percentage coupons whose "amount_off" holds a rate other than the one in "basis_points"/,
          make: [`UPDATE "coupons" SET "amount_off" = 2000 WHERE "id" = 'c_percent'`],
          mend: [`UPDATE "coupons" SET "amount_off" = 1000 WHERE "id" = 'c_percent'`],
        },
        ...[`{"currency": "eur"}`, `{"currency": "usdt"}`, `{"currency": " gbp "}`, `{"currency": "JPY", "reportingCurrency": null}`].map((config) => ({
          row: `an old reporting key with nothing to replace it, ${config}`,
          migration: '_remove_billing_config_currency_key',
          says: /"applications": 1 row\(s\) have a "currency" key in "billing_config" and no three-letter "reportingCurrency" to replace it/,
          make: [`UPDATE "applications" SET "billing_config" = '${config}'::jsonb WHERE "id" = 'app_b'`],
          mend: [`UPDATE "applications" SET "billing_config" = '{}'::jsonb WHERE "id" = 'app_b'`],
        })),
      ];

      for (const { row, migration, says, make, mend } of cases) {
        for (const statement of make) await db.$executeRawUnsafe(statement);
        // Soft, so one run names every kind of row that got through.
        expect.soft(refusalOf('_price_and_coupon_column_drop_checks'), `${row}: the checks`).toMatch(says);
        const own = refusalOf(migration);
        expect.soft(own, `${row}: ${migration}`).toMatch(says);
        expect.soft(own, row).toContain('This migration changed nothing; the migrations before it are applied.');
        expect.soft(own, row).toContain(`--rolled-back 20261014`);
        expect(await shape(), row).toMatchObject(RC7_SHAPE);
        for (const statement of mend) await db.$executeRawUnsafe(statement);
      }
      expect(refusalOf('_price_and_coupon_column_drop_checks')).toBe('the file ran');
    }, 480_000);

    it('apply once every row can be migrated, and guess nothing on the way', async () => {
      const before = {
        pending: await subscription('sub_pending'),
        onBad: await subscription('sub_on_bad'),
        byHand: await subscription('sub_badcur'),
        amounts: await rows(`SELECT "coupon_id", "currency", "amount_off" FROM "coupon_amounts" ORDER BY 1, 2`),
        prices: Number((await one<{ n: bigint }>(`SELECT count(*) AS "n" FROM "plan_prices"`)).n),
      };
      // A list an operator emptied, a list that is NULL, and both reporting keys at once.
      await db.$executeRawUnsafe(`UPDATE "billing_credentials" SET "currencies" = '{}' WHERE "application_id" = 'app_b' AND "provider" = 'razorpay'`);
      await db.$executeRawUnsafe(`UPDATE "billing_credentials" SET "currencies" = NULL WHERE "application_id" = 'app_b' AND "provider" = 'mollie'`);
      await db.$executeRawUnsafe(`UPDATE "applications" SET "billing_config" = '{"currency": "usd", "reportingCurrency": "EUR", "enabled": true}'::jsonb WHERE "id" = 'app_b'`);

      prismaCli(['migrate', 'resolve', '--rolled-back', CONTRACT[0]!, '--schema', SCHEMA]);
      prismaCli(['migrate', 'deploy', '--schema', SCHEMA]);
      expect(prismaCli(['migrate', 'status', '--schema', SCHEMA])).toContain('Database schema is up to date');

      expect(await shape()).toEqual({
        subscriptionConstraints: ['subscriptions_plan_price_id_plan_id_fkey', 'subscriptions_price_snapshot'],
        droppedColumns: [],
        oldReportingKeys: 0,
      });
      expect(
        await rows(`SELECT "conname", "convalidated" FROM pg_constraint WHERE "conname" IN ('plan_prices_currency_code', 'plans_free_has_no_price', 'coupons_rate_by_kind') ORDER BY 1`),
      ).toEqual([
        { conname: 'coupons_rate_by_kind', convalidated: true },
        { conname: 'plan_prices_currency_code', convalidated: true },
        { conname: 'plans_free_has_no_price', convalidated: true },
      ]);

      // Nothing was priced, linked, copied or invented to get here.
      expect(await subscription('sub_pending')).toEqual(before.pending);
      expect(await subscription('sub_on_bad')).toEqual(before.onBad);
      expect(await subscription('sub_badcur')).toEqual(before.byHand);
      expect(before.pending).toEqual({ plan_price_id: null, currency: null, unit_amount: null });
      expect(await rows(`SELECT "coupon_id", "currency", "amount_off" FROM "coupon_amounts" ORDER BY 1, 2`)).toEqual(before.amounts);
      expect(Number((await one<{ n: bigint }>(`SELECT count(*) AS "n" FROM "plan_prices"`)).n)).toBe(before.prices);
      expect(await one(`SELECT "basis_points" FROM "coupons" WHERE "id" = 'c_percent'`)).toEqual({ basis_points: 1000 });
      expect(await currenciesOf('app_b', 'razorpay')).toEqual([]);
      expect(await currenciesOf('app_b', 'mollie')).toEqual([]);
      // A per-unit figure moves to the plan's own metadata as stored, and nowhere else.
      expect(await one(`SELECT "metadata" FROM "plans" WHERE "id" = 'pl_metered'`)).toEqual({ metadata: { pricePerUnitCents: 5 } });
      expect(await rows(`SELECT "id" FROM "plans" WHERE "metadata" ? 'pricePerUnitCents' ORDER BY 1`)).toEqual([{ id: 'pl_metered' }]);
      // The same currency in another letter case is written as the price row has it.
      expect(await subscription('sub_inr')).toMatchObject({ currency: 'INR', unit_amount: 149900 });
      expect(await one(`SELECT "billing_config" FROM "applications" WHERE "id" = 'app_b'`)).toEqual({
        billing_config: { reportingCurrency: 'EUR', enabled: true },
      });
    }, 240_000);

    it('leave constraints that refuse each shape the old columns allowed', async () => {
      const write = (sql: string) => db.$executeRawUnsafe(sql);
      await expect(write(`UPDATE "subscriptions" SET "plan_price_id" = NULL WHERE "id" = 'sub_default'`)).rejects.toThrow(/subscriptions_price_snapshot/);
      await expect(write(`UPDATE "subscriptions" SET "currency" = 'USD', "unit_amount" = 2000 WHERE "id" = 'sub_pending'`)).rejects.toThrow(/subscriptions_price_snapshot/);
      await expect(write(`UPDATE "subscriptions" SET "plan_price_id" = 'pp_same' WHERE "id" = 'sub_default'`)).rejects.toThrow(/subscriptions_plan_price_id_plan_id_fkey/);
      await expect(write(`DELETE FROM "plan_prices" WHERE "id" = 'pp_inr'`)).rejects.toThrow(/subscriptions_plan_price_id_plan_id_fkey/);
      await expect(write(`UPDATE "plans" SET "is_free" = true WHERE "id" = 'pl_b'`)).rejects.toThrow(/plans_free_has_no_price/);
      await expect(write(`UPDATE "coupons" SET "basis_points" = NULL WHERE "id" = 'c_percent'`)).rejects.toThrow(/coupons_rate_by_kind/);
      await expect(write(`UPDATE "coupons" SET "basis_points" = 500 WHERE "id" = 'c_fixed'`)).rejects.toThrow(/coupons_rate_by_kind/);
      await expect(write(`UPDATE "coupons" SET "currencies" = NULL WHERE "id" = 'c_fixed'`)).rejects.toThrow(/23502|null constraint|null value/i);
      await expect(write(`UPDATE "billing_credentials" SET "currencies" = NULL WHERE "application_id" = 'app_b'`)).rejects.toThrow(/23502|null constraint|null value/i);
      await expect(write(`UPDATE "plan_prices" SET "currency" = 'usd' WHERE "id" = 'pp_same'`)).rejects.toThrow(/plan_prices_currency_code/);
    });

    it('still let an Application go with its subscriptions and the prices they name', async () => {
      await db.$executeRawUnsafe(`DELETE FROM "applications" WHERE "id" = 'app_b'`);
      expect(await rows(`SELECT "id" FROM "plan_prices" WHERE "application_id" = 'app_b'`)).toEqual([]);
      expect(await rows(`SELECT "id" FROM "subscriptions" WHERE "application_id" = 'app_b'`)).toEqual([]);
    });
  });
});
