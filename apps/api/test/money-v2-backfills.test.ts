/**
 * The money-model backfills, run against rows shaped like production's.
 *
 * `prisma migrate deploy` is all or nothing, so by the time a test runs every
 * backfill has already run over an empty database. Each one is a data-only
 * migration whose whole file is its SQL, so the test writes the rows the
 * backfill was meant to meet, executes that same file, and executes it again
 * to hold that a second run changes nothing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { CURRENCY_TABLE, isSellableCurrency } from '@rekey.dev/shared-types';
import { prisma } from '../src/lib/prisma.js';
import { getModule } from '../src/modules/billing/providers/registry.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../prisma/migrations');

function migrationSql(suffix: string): string {
  const dir = readdirSync(MIGRATIONS).find((name) => name.endsWith(suffix));
  if (dir === undefined) throw new Error(`no migration ends with ${suffix}`);
  return readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
}

/** Prisma prepares one statement at a time, so the file is run statement by statement. */
async function run(suffix: string): Promise<void> {
  const statements = migrationSql(suffix)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
  for (const statement of statements) await prisma.$executeRawUnsafe(statement);
}

/** Every row of the tables a backfill may touch, to compare before and after a second run. */
async function snapshot(): Promise<string> {
  const [plans, prices, subscriptions, payments, sessions, coupons, amounts, credentials, refunds, ledger] = await Promise.all([
    prisma.plan.findMany({ orderBy: { id: 'asc' } }),
    prisma.planPrice.findMany({ orderBy: { id: 'asc' } }),
    prisma.subscription.findMany({ orderBy: { id: 'asc' } }),
    prisma.payment.findMany({ orderBy: { id: 'asc' } }),
    prisma.checkoutSession.findMany({ orderBy: { id: 'asc' } }),
    prisma.coupon.findMany({ orderBy: { id: 'asc' } }),
    prisma.couponAmount.findMany({ orderBy: { id: 'asc' } }),
    prisma.$queryRaw`SELECT * FROM "billing_credentials" ORDER BY "id"`,
    prisma.refund.findMany({ orderBy: { id: 'asc' } }),
    prisma.creditLedger.findMany({ orderBy: { id: 'asc' } }),
  ]);
  return JSON.stringify({ plans, prices, subscriptions, payments, sessions, coupons, amounts, credentials, refunds, ledger });
}

async function runTwice(suffix: string): Promise<void> {
  await run(suffix);
  const once = await snapshot();
  await run(suffix);
  expect(await snapshot(), `${suffix} changed rows on its second run`).toBe(once);
}

const BACKFILLS = [
  'money_v2_04_backfill_default_prices',
  'money_v2_05_backfill_plan_is_free',
  'money_v2_06_backfill_subscription_prices',
  'money_v2_08_backfill_payment_prices',
  'money_v2_09_backfill_checkout_amounts',
  'money_v2_10_backfill_coupon_amounts',
  'money_v2_11_backfill_provider_currencies',
  'money_v2_12_backfill_refunds',
  'money_v2_13_backfill_credit_payments',
] as const;

describe('money model backfills', () => {
  let applicationId: string;
  let n = 0;

  async function newApplication(): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const tenant = await prisma.tenant.create({ data: { name: `WS ${suffix}`, ownerEmail: `op-${suffix}@example.com` } });
    const application = await prisma.application.create({
      data: {
        tenantId: tenant.id,
        name: `App ${suffix}`,
        slug: `mv2-${suffix}`,
        publicKey: `rp_pub_mv2-${suffix}_${randomUUID().slice(0, 12)}`,
        authConfig: { mfa: 'optional', methods: ['password'], tokenAlg: 'HS256' },
        billingConfig: {},
      },
    });
    return application.id;
  }

  /** A plan as an API from before the price row wrote it: no default price, `is_free` at its column default. */
  function oldPlan(data: {
    amount: number;
    currency?: string;
    metadata?: object;
    pricePerUnitCents?: number;
    active?: boolean;
    kind?: 'SUBSCRIPTION' | 'USAGE';
    applicationId?: string;
  }) {
    n += 1;
    return prisma.plan.create({
      data: { applicationId, slug: `plan-${n}`, name: `Plan ${n}`, ...data, metadata: data.metadata ?? {} },
    });
  }

  async function newEndUser(inApplication = applicationId): Promise<string> {
    n += 1;
    const user = await prisma.endUser.create({
      data: { applicationId: inApplication, email: `buyer-${n}-${randomUUID().slice(0, 6)}@example.com`, passwordHash: 'x' },
    });
    return user.id;
  }

  /** A subscription written straight to the row, in any state an older API or newer code could have left. */
  async function oldSubscription(data: {
    planId: string;
    status?: 'PENDING' | 'ACTIVE' | 'CANCELED';
    currency?: string;
    unitAmount?: number;
    planPriceId?: string;
    provider?: string;
    applicationId?: string;
  }): Promise<string> {
    const id = `sub_${randomUUID().slice(0, 12)}`;
    const inApplication = data.applicationId ?? applicationId;
    await prisma.$executeRaw`
      INSERT INTO "subscriptions" ("id", "application_id", "end_user_id", "plan_id", "status", "currency", "unit_amount", "plan_price_id", "provider", "metadata", "created_at", "updated_at")
      VALUES (${id}, ${inApplication}, ${await newEndUser(inApplication)}, ${data.planId}, ${data.status ?? 'ACTIVE'}::"SubscriptionStatus",
              ${data.currency ?? null}, ${data.unitAmount ?? null}, ${data.planPriceId ?? null}, ${data.provider ?? null}, '{}'::jsonb, now(), now())`;
    return id;
  }

  /** A price row as stored, whatever the API would have refused. */
  async function rawPrice(data: {
    planId: string;
    currency: string;
    amount: number;
    archived?: boolean;
    applicationId?: string;
    createdAt?: Date;
    metadata?: object;
  }): Promise<string> {
    const id = `pp_raw_${randomUUID().slice(0, 12)}`;
    await prisma.$executeRaw`
      INSERT INTO "plan_prices" ("id", "application_id", "plan_id", "currency", "amount", "metadata", "archived_at", "created_at", "updated_at")
      VALUES (${id}, ${data.applicationId ?? applicationId}, ${data.planId}, ${data.currency}, ${data.amount},
              ${JSON.stringify(data.metadata ?? {})}::jsonb, ${data.archived === true ? new Date() : null}, ${data.createdAt ?? new Date()}, now())`;
    return id;
  }

  const plan = (id: string) => prisma.plan.findUniqueOrThrow({ where: { id } });
  const price = (id: string) => prisma.planPrice.findUniqueOrThrow({ where: { id } });
  const subscription = (id: string) => prisma.subscription.findUniqueOrThrow({ where: { id } });
  const defaultPriceOf = async (planId: string) => price((await plan(planId)).defaultPriceId!);

  beforeEach(async () => {
    applicationId = await newApplication();
  });

  describe('default prices (04) and the free flag (05)', () => {
    it('gives a paid plan a price row holding its registrations exactly as stored', async () => {
      const stripe = { priceId: 'price_live_1', mode: 'live' };
      // Registered before Rekey recorded the mode: there is no `mode` to copy, and none is invented.
      const paypal = { planId: 'P-OLD-1' };
      const razorpay = { planId: 'plan_rzp_1', mode: 'test', productId: 'prod_1' };
      const paid = await oldPlan({
        amount: 2000,
        currency: 'usd',
        metadata: { stripe, paypal, razorpay, features: { seats: 5 } },
      });
      await prisma.plan.update({ where: { id: paid.id }, data: { registrationStatus: 'REGISTERED' } });
      const before = (await plan(paid.id)).metadata;

      await runTwice('money_v2_04_backfill_default_prices');

      const after = await plan(paid.id);
      const row = await price(after.defaultPriceId!);
      expect(row).toMatchObject({
        planId: paid.id,
        applicationId,
        currency: 'USD',
        amount: 2000,
        countries: [],
        archivedAt: null,
        registrationStatus: 'REGISTERED',
      });
      expect(row.metadata).toEqual({ stripe, paypal, razorpay });
      expect((row.metadata as { paypal: object }).paypal).not.toHaveProperty('mode');
      // The plan's own metadata is still what the API reads.
      expect(after.metadata).toEqual(before);
      expect(after).toMatchObject({ amount: 2000, currency: 'usd' });
    });

    it('prices an archived plan too, and a plan with no registration gets an empty one', async () => {
      const retired = await oldPlan({ amount: 900, currency: 'EUR', active: false });
      await run('money_v2_04_backfill_default_prices');
      expect(await defaultPriceOf(retired.id)).toMatchObject({ currency: 'EUR', amount: 900, metadata: {} });
    });

    it('adds one row to a plan already sold in two currencies, and leaves the other alone', async () => {
      const paid = await oldPlan({ amount: 2000, currency: 'USD' });
      const inr = await prisma.planPrice.create({
        data: { applicationId, planId: paid.id, currency: 'INR', amount: 149900, metadata: { razorpay: { planId: 'plan_inr' } } },
      });

      await runTwice('money_v2_04_backfill_default_prices');

      const prices = await prisma.planPrice.findMany({ where: { planId: paid.id }, orderBy: { currency: 'asc' } });
      expect(prices.map((row) => [row.currency, row.amount])).toEqual([
        ['INR', 149900],
        ['USD', 2000],
      ]);
      expect((await plan(paid.id)).defaultPriceId).toBe(prices[1]!.id);
      expect(await price(inr.id)).toEqual(inr);
    });

    it('archives a price in the plan currency at another amount, and the default is the plan amount with its registrations', async () => {
      const stripe = { priceId: 'price_2000' };
      const paid = await oldPlan({ amount: 2000, currency: 'USD', metadata: { stripe } });
      const stray = await rawPrice({ planId: paid.id, currency: 'USD', amount: 1500 });

      await runTwice('money_v2_04_backfill_default_prices');

      const row = await defaultPriceOf(paid.id);
      expect(row).toMatchObject({ currency: 'USD', amount: 2000, archivedAt: null, metadata: { stripe } });
      expect(row.id).not.toBe(stray);
      const archived = await price(stray);
      expect(archived).toMatchObject({ amount: 1500, metadata: {} });
      expect(archived.archivedAt).not.toBeNull();
    });

    it('adopts a price already at the plan amount as the default, and copies the plan registrations onto it', async () => {
      const razorpay = { planId: 'plan_rzp_same' };
      const paid = await oldPlan({ amount: 900, currency: 'eur', metadata: { razorpay, note: 'kept on the plan only' } });
      await prisma.plan.update({ where: { id: paid.id }, data: { registrationStatus: 'FAILED', registrationError: 'declined' } });
      const existing = await rawPrice({ planId: paid.id, currency: 'EUR', amount: 900, metadata: { stripe: { priceId: 'stale' } } });

      await runTwice('money_v2_04_backfill_default_prices');

      expect((await plan(paid.id)).defaultPriceId).toBe(existing);
      expect(await price(existing)).toMatchObject({
        archivedAt: null,
        metadata: { razorpay },
        registrationStatus: 'FAILED',
        registrationError: 'declined',
      });
      expect(await prisma.planPrice.count({ where: { planId: paid.id } })).toBe(1);
    });

    it('prices a plan whose only row in its currency is archived, and runs again after that default is archived too', async () => {
      const paid = await oldPlan({ amount: 2000, currency: 'USD' });
      const old = await rawPrice({ planId: paid.id, currency: 'USD', amount: 2000, archived: true });

      await runTwice('money_v2_04_backfill_default_prices');

      const first = await defaultPriceOf(paid.id);
      expect(first.id).not.toBe(old);
      expect(first).toMatchObject({ archivedAt: null, amount: 2000 });

      // The plan is re-priced by an API that knows nothing of price rows, after its default was archived.
      await prisma.plan.update({ where: { id: paid.id }, data: { defaultPriceId: null, amount: 2400 } });
      await prisma.planPrice.update({ where: { id: first.id }, data: { archivedAt: new Date() } });

      await runTwice('money_v2_04_backfill_default_prices');

      const second = await defaultPriceOf(paid.id);
      expect(second).toMatchObject({ archivedAt: null, amount: 2400 });
      expect(await prisma.planPrice.count({ where: { planId: paid.id } })).toBe(3);
    });

    it('keeps a default the API has written since, whatever the plan columns say', async () => {
      const paid = await oldPlan({ amount: 2000, currency: 'USD', metadata: { stripe: { priceId: 'on_the_plan' } } });
      const chosen = await rawPrice({ planId: paid.id, currency: 'EUR', amount: 1800, metadata: { stripe: { priceId: 'on_the_price' } } });
      const own = await rawPrice({ planId: paid.id, currency: 'USD', amount: 1500 });
      await prisma.plan.update({ where: { id: paid.id }, data: { defaultPriceId: chosen } });
      // The same, with a row at the plan's own amount: it must not take the default over, nor the plan's registrations.
      const second = await oldPlan({ amount: 2000, currency: 'USD', metadata: { stripe: { priceId: 'on_the_plan' } } });
      const secondChosen = await rawPrice({ planId: second.id, currency: 'EUR', amount: 1800 });
      await rawPrice({ planId: second.id, currency: 'USD', amount: 2000, metadata: { stripe: { priceId: 'on_the_price' } } });
      await prisma.plan.update({ where: { id: second.id }, data: { defaultPriceId: secondChosen } });
      const before = await snapshot();

      await run('money_v2_04_backfill_default_prices');

      expect(await snapshot()).toBe(before);
      expect((await price(own)).archivedAt).toBeNull();
    });

    // A price row stored in lower case can no longer be written here: the in-order test seeds one before the CHECK exists.
    it('gives a plan whose currency is not three letters no price and no default', async () => {
      const malformed = await oldPlan({ amount: 500, currency: 'USDT' });
      const symbol = await oldPlan({ amount: 500, currency: 'US$' });

      await runTwice('money_v2_04_backfill_default_prices');

      expect(await plan(malformed.id)).toMatchObject({ defaultPriceId: null, currency: 'USDT' });
      expect(await plan(symbol.id)).toMatchObject({ defaultPriceId: null, currency: 'US$' });
      expect(await prisma.planPrice.count({ where: { planId: { in: [malformed.id, symbol.id] } } })).toBe(0);
    });

    it('files a price under its plan Application', async () => {
      const other = await newApplication();
      const paid = await oldPlan({ amount: 2000, currency: 'USD' });
      const misfiled = await rawPrice({ planId: paid.id, currency: 'INR', amount: 149900, applicationId: other });
      const sameAmount = await oldPlan({ amount: 700, currency: 'EUR' });
      const misfiledDefault = await rawPrice({ planId: sameAmount.id, currency: 'EUR', amount: 700, applicationId: other });

      await runTwice('money_v2_04_backfill_default_prices');

      expect((await price(misfiled)).applicationId).toBe(applicationId);
      expect(await defaultPriceOf(sameAmount.id)).toMatchObject({ id: misfiledDefault, applicationId });
      expect(await prisma.planPrice.count({ where: { applicationId: other } })).toBe(0);
    });

    it('leaves a free plan and a metered plan at amount 0 without a price, and flags only the first as free', async () => {
      const free = await oldPlan({ amount: 0 });
      const metered = await oldPlan({ amount: 0, pricePerUnitCents: 5, kind: 'USAGE' });
      const paid = await oldPlan({ amount: 500 });
      // Flags an API could not have written, to hold that the backfill corrects in both directions.
      const wronglyFree = await oldPlan({ amount: 500 });
      const wronglyFreeMetered = await oldPlan({ amount: 0, pricePerUnitCents: 5, kind: 'USAGE' });
      await prisma.plan.updateMany({ where: { id: { in: [wronglyFree.id, wronglyFreeMetered.id] } }, data: { isFree: true } });

      await runTwice('money_v2_04_backfill_default_prices');
      await runTwice('money_v2_05_backfill_plan_is_free');

      expect(await plan(free.id)).toMatchObject({ isFree: true, defaultPriceId: null });
      expect(await plan(metered.id)).toMatchObject({ isFree: false, defaultPriceId: null });
      expect(await plan(paid.id)).toMatchObject({ isFree: false });
      expect(await plan(wronglyFree.id)).toMatchObject({ isFree: false });
      expect(await plan(wronglyFreeMetered.id)).toMatchObject({ isFree: false });
      expect(await prisma.planPrice.count({ where: { planId: { in: [free.id, metered.id] } } })).toBe(0);
    });
  });

  describe('subscription prices (06)', () => {
    it('links, prices or leaves each kind of subscription', async () => {
      const paid = await oldPlan({ amount: 2000, currency: 'USD' });
      const inr = await prisma.planPrice.create({ data: { applicationId, planId: paid.id, currency: 'INR', amount: 149900 } });
      const free = await oldPlan({ amount: 0 });
      const metered = await oldPlan({ amount: 0, pricePerUnitCents: 5, kind: 'USAGE' });
      await run('money_v2_04_backfill_default_prices');
      const defaultPriceId = (await plan(paid.id)).defaultPriceId!;

      const atDefault = await oldSubscription({ planId: paid.id, currency: 'USD', unitAmount: 1900 });
      const atInr = await oldSubscription({ planId: paid.id, currency: 'inr', unitAmount: 149900 });
      const granted = await oldSubscription({ planId: paid.id });
      const canceled = await oldSubscription({ planId: paid.id, status: 'CANCELED' });
      const pending = await oldSubscription({ planId: paid.id, status: 'PENDING' });
      const onFree = await oldSubscription({ planId: free.id });
      const freeAtZero = await oldSubscription({ planId: free.id, currency: 'USD', unitAmount: 0 });
      const meteredAtZero = await oldSubscription({ planId: metered.id, currency: 'USD', unitAmount: 0 });
      // Paid in a currency the plan was later re-priced out of.
      const orphan = await oldSubscription({ planId: paid.id, currency: 'GBP', unitAmount: 1600 });
      const orphanLower = await oldSubscription({ planId: paid.id, currency: 'gbp', unitAmount: 1500 });
      const malformed = await oldSubscription({ planId: paid.id, currency: 'US$', unitAmount: 700 });
      const subscriptions = await prisma.subscription.count({ where: { applicationId } });

      await runTwice('money_v2_06_backfill_subscription_prices');

      // What a subscription pays is never rewritten; only the link is added.
      expect(await subscription(atDefault)).toMatchObject({ planPriceId: defaultPriceId, currency: 'USD', unitAmount: 1900 });
      expect(await subscription(atInr)).toMatchObject({ planPriceId: inr.id, currency: 'inr', unitAmount: 149900 });
      expect(await subscription(granted)).toMatchObject({ planPriceId: defaultPriceId, currency: 'USD', unitAmount: 2000 });
      expect(await subscription(canceled)).toMatchObject({ planPriceId: defaultPriceId, currency: 'USD', unitAmount: 2000 });
      const untouched = { planPriceId: null, currency: null, unitAmount: null };
      expect(await subscription(pending)).toMatchObject({ ...untouched, status: 'PENDING' });
      expect(await subscription(onFree)).toMatchObject(untouched);
      expect(await subscription(freeAtZero)).toMatchObject(untouched);
      expect(await subscription(meteredAtZero)).toMatchObject(untouched);
      expect(await subscription(malformed)).toMatchObject({ planPriceId: null, currency: 'US$', unitAmount: 700 });

      const orphaned = await subscription(orphan);
      expect(orphaned).toMatchObject({ currency: 'GBP', unitAmount: 1600 });
      const archived = await price(orphaned.planPriceId!);
      expect(archived).toMatchObject({ planId: paid.id, applicationId, currency: 'GBP', amount: 1600 });
      expect(archived.archivedAt).not.toBeNull();
      expect(await subscription(orphanLower)).toMatchObject({ planPriceId: archived.id, currency: 'gbp', unitAmount: 1500 });
      expect(await prisma.planPrice.count({ where: { planId: paid.id } })).toBe(3);

      expect(await prisma.subscription.count({ where: { applicationId } })).toBe(subscriptions);
    });

    it('keeps a subscriber who pays nothing on a paid plan at nothing', async () => {
      const paid = await oldPlan({ amount: 2000, currency: 'usd' });
      const inr = await prisma.planPrice.create({ data: { applicationId, planId: paid.id, currency: 'INR', amount: 149900 } });
      await run('money_v2_04_backfill_default_prices');
      const defaultPriceId = (await plan(paid.id)).defaultPriceId!;
      const zeroAtDefault = await oldSubscription({ planId: paid.id, currency: 'USD', unitAmount: 0 });
      const zeroAtInr = await oldSubscription({ planId: paid.id, currency: 'INR', unitAmount: 0 });
      const zeroElsewhere = await oldSubscription({ planId: paid.id, currency: 'EUR', unitAmount: 0 });

      await runTwice('money_v2_06_backfill_subscription_prices');

      expect(await subscription(zeroAtDefault)).toMatchObject({ planPriceId: defaultPriceId, currency: 'USD', unitAmount: 0 });
      expect(await subscription(zeroAtInr)).toMatchObject({ planPriceId: inr.id, currency: 'INR', unitAmount: 0 });
      // No EUR price to name, and no price row may be at 0, so it names the default in the default's currency.
      expect(await subscription(zeroElsewhere)).toMatchObject({ planPriceId: defaultPriceId, currency: 'USD', unitAmount: 0 });
      expect(await prisma.planPrice.count({ where: { planId: paid.id } })).toBe(2);
    });

    it('writes the price row currency, not the plan spelling, on a subscription it prices', async () => {
      const paid = await oldPlan({ amount: 2000, currency: 'usd' });
      await run('money_v2_04_backfill_default_prices');
      const granted = await oldSubscription({ planId: paid.id });
      await run('money_v2_06_backfill_subscription_prices');
      expect(await subscription(granted)).toMatchObject({ currency: 'USD', unitAmount: 2000 });
    });

    it('reads the amounts back onto a subscription that names a price and lost them', async () => {
      const paid = await oldPlan({ amount: 2000, currency: 'USD' });
      const inr = await prisma.planPrice.create({ data: { applicationId, planId: paid.id, currency: 'INR', amount: 149900 } });
      await run('money_v2_04_backfill_default_prices');
      const lost = await oldSubscription({ planId: paid.id, planPriceId: inr.id });

      await runTwice('money_v2_06_backfill_subscription_prices');

      expect(await subscription(lost)).toMatchObject({ planPriceId: inr.id, currency: 'INR', unitAmount: 149900 });
    });

    it('prefers a live price to an older archived one in the same currency', async () => {
      const paid = await oldPlan({ amount: 2000, currency: 'USD' });
      await rawPrice({ planId: paid.id, currency: 'INR', amount: 99900, archived: true, createdAt: new Date(Date.now() - 86_400_000) });
      const live = await rawPrice({ planId: paid.id, currency: 'INR', amount: 149900 });
      await run('money_v2_04_backfill_default_prices');
      const buyer = await oldSubscription({ planId: paid.id, currency: 'INR', unitAmount: 149900 });

      await runTwice('money_v2_06_backfill_subscription_prices');

      expect((await subscription(buyer)).planPriceId).toBe(live);
    });

    it('keeps every price newer code has already written', async () => {
      const paid = await oldPlan({ amount: 2000, currency: 'USD' });
      const inr = await prisma.planPrice.create({ data: { applicationId, planId: paid.id, currency: 'INR', amount: 149900 } });
      await run('money_v2_04_backfill_default_prices');
      const defaultPriceId = (await plan(paid.id)).defaultPriceId!;
      // Became free after its subscriber was priced at a negotiated nothing.
      const nowFree = await oldPlan({ amount: 2000, currency: 'USD' });
      await run('money_v2_04_backfill_default_prices');
      const nowFreePriceId = (await plan(nowFree.id)).defaultPriceId!;
      await prisma.plan.update({ where: { id: nowFree.id }, data: { amount: 0 } });

      const written = [
        // Would be un-priced by the zero-on-a-free-plan statement.
        await oldSubscription({ planId: nowFree.id, planPriceId: nowFreePriceId, currency: 'USD', unitAmount: 0 }),
        // Would mint an archived GBP row, and be re-linked to it.
        await oldSubscription({ planId: paid.id, planPriceId: defaultPriceId, currency: 'GBP', unitAmount: 1600 }),
        // Would be re-linked to the live INR price.
        await oldSubscription({ planId: paid.id, planPriceId: defaultPriceId, currency: 'INR', unitAmount: 149900 }),
        // Would be re-linked to the default price by the pays-nothing statement.
        await oldSubscription({ planId: paid.id, planPriceId: inr.id, currency: 'EUR', unitAmount: 0 }),
      ];
      const before = await Promise.all(written.map(subscription));

      await runTwice('money_v2_06_backfill_subscription_prices');

      expect(await Promise.all(written.map(subscription))).toEqual(before);
      expect(await prisma.planPrice.count({ where: { planId: paid.id, currency: 'GBP' } })).toBe(0);
    });
  });

  describe('payments (08)', () => {
    it('links a payment that took money in its subscription currency, and says what it can prove about each', async () => {
      const paid = await oldPlan({ amount: 2000, currency: 'USD' });
      await run('money_v2_04_backfill_default_prices');
      const defaultPriceId = (await plan(paid.id)).defaultPriceId!;
      const sub = await prisma.subscription.create({
        data: {
          applicationId,
          endUserId: await newEndUser(),
          planId: paid.id,
          status: 'ACTIVE',
          provider: 'stripe',
          currency: 'USD',
          unitAmount: 1900,
          planPriceId: defaultPriceId,
        },
      });
      const pay = (data: { amount?: number; currency?: string; subscriptionId?: string | null; status?: 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'REFUNDED' | 'PARTIALLY_REFUNDED' }) =>
        prisma.payment.create({
          data: {
            applicationId,
            subscriptionId: data.subscriptionId === undefined ? sub.id : data.subscriptionId,
            amount: data.amount ?? 1900,
            currency: data.currency ?? 'USD',
            status: data.status ?? 'SUCCEEDED',
          },
        });
      const unapplied = (paymentId: string, status: 'OPEN' | 'DISMISSED', provider: string) =>
        prisma.unappliedPayment.create({ data: { applicationId, paymentId, provider, amount: 1900, currency: 'USD', status } });

      const matching = await pay({ currency: 'usd' });
      const discounted = await pay({ amount: 1400 });
      const refunded = await pay({ status: 'REFUNDED' });
      const partlyRefunded = await pay({ status: 'PARTIALLY_REFUNDED' });
      const failed = await pay({ status: 'FAILED' });
      const pendingPayment = await pay({ status: 'PENDING' });
      const foreign = await pay({ currency: 'INR' });
      const loose = await pay({ subscriptionId: null });
      const openCase = await pay({});
      await unapplied(openCase.id, 'OPEN', 'paypal');
      const looseOpenCase = await pay({ subscriptionId: null });
      await unapplied(looseOpenCase.id, 'OPEN', 'razorpay');
      const closedCase = await pay({ subscriptionId: null });
      await unapplied(closedCase.id, 'DISMISSED', 'paypal');
      // Already linked by newer code, at an amount of its own: the backfill must not overwrite it.
      const linked = await prisma.payment.create({
        data: { applicationId, subscriptionId: sub.id, amount: 1700, currency: 'USD', status: 'SUCCEEDED', planPriceId: defaultPriceId, unitAmount: 1700, provider: 'paypal' },
      });
      const inr = await prisma.planPrice.create({ data: { applicationId, planId: paid.id, currency: 'INR', amount: 149900 } });
      const linkedElsewhere = await prisma.payment.create({
        data: { applicationId, subscriptionId: sub.id, amount: 1900, currency: 'USD', status: 'SUCCEEDED', planPriceId: inr.id },
      });
      // Recorded by newer code as matching no price.
      const amountOnly = await prisma.payment.create({
        data: { applicationId, subscriptionId: sub.id, amount: 1900, currency: 'USD', status: 'SUCCEEDED', unitAmount: 1234 },
      });
      // Rows that point across Applications are not evidence of anything.
      const other = await newApplication();
      const acrossSubscription = await prisma.payment.create({
        data: { applicationId: other, subscriptionId: sub.id, amount: 1900, currency: 'USD', status: 'SUCCEEDED' },
      });
      const acrossCase = await pay({ subscriptionId: null });
      await prisma.unappliedPayment.create({
        data: { applicationId: other, paymentId: acrossCase.id, provider: 'paypal', amount: 1900, currency: 'USD', status: 'OPEN' },
      });

      await runTwice('money_v2_08_backfill_payment_prices');

      const read = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
      const linkedAtPrice = { planPriceId: defaultPriceId, unitAmount: 1900, provider: 'stripe', verification: 'VERIFIED' };
      const unlinked = { planPriceId: null, unitAmount: null };
      expect(await read(matching.id)).toMatchObject({ ...linkedAtPrice, currency: 'usd', discountAmount: 0, providerChargeId: null });
      expect(await read(refunded.id)).toMatchObject(linkedAtPrice);
      expect(await read(partlyRefunded.id)).toMatchObject(linkedAtPrice);
      // For the subscription's price, but not at it: the amount it was charged at is not on record.
      expect(await read(discounted.id)).toMatchObject({ planPriceId: defaultPriceId, unitAmount: null, provider: 'stripe' });
      expect(await read(failed.id)).toMatchObject({ ...unlinked, provider: 'stripe', verification: 'VERIFIED' });
      expect(await read(pendingPayment.id)).toMatchObject({ ...unlinked, provider: 'stripe' });
      expect(await read(foreign.id)).toMatchObject({ ...unlinked, provider: 'stripe', currency: 'INR' });
      expect(await read(loose.id)).toMatchObject({ ...unlinked, provider: null, currency: 'USD', verification: 'VERIFIED' });
      // The subscription's provider wins over the case's.
      expect(await read(openCase.id)).toMatchObject({ ...unlinked, provider: 'stripe', verification: 'UNVERIFIED' });
      expect(await read(looseOpenCase.id)).toMatchObject({ ...unlinked, provider: 'razorpay', verification: 'UNVERIFIED' });
      expect(await read(closedCase.id)).toMatchObject({ ...unlinked, provider: 'paypal', verification: 'VERIFIED' });
      expect(await read(linked.id)).toMatchObject({ planPriceId: defaultPriceId, unitAmount: 1700, provider: 'paypal' });
      expect(await read(linkedElsewhere.id)).toMatchObject({ planPriceId: inr.id, unitAmount: null });
      expect(await read(amountOnly.id)).toMatchObject({ planPriceId: null, unitAmount: 1234 });
      expect(await read(acrossSubscription.id)).toMatchObject({ ...unlinked, provider: null });
      expect(await read(acrossCase.id)).toMatchObject({ ...unlinked, provider: null, verification: 'VERIFIED' });
    });
  });

  describe('checkout sessions (09)', () => {
    it('copies the expected charge and the discount out of the metadata, and derives a recurring charge', async () => {
      const paid = await oldPlan({ amount: 2000 });
      const sub = await prisma.subscription.create({ data: { applicationId, endUserId: await newEndUser(), planId: paid.id } });
      const session = (metadata: object, columns: { kind?: 'ONE_TIME' | 'RECURRING'; unitAmount?: number } = {}) =>
        prisma.checkoutSession.create({
          data: {
            applicationId,
            endUserId: sub.endUserId,
            subscriptionId: sub.id,
            provider: 'paypal',
            providerSessionId: `ORDER-${randomUUID().slice(0, 8)}`,
            mode: 'EMBEDDED',
            paymentMode: 'TEST',
            kind: columns.kind ?? 'ONE_TIME',
            ...(columns.unitAmount !== undefined && { unitAmount: columns.unitAmount, currency: 'USD' }),
            successUrl: 'https://app.example/ok',
            cancelUrl: 'https://app.example/no',
            expiresAt: new Date(Date.now() + 60_000),
            metadata,
          },
        });
      const oneTime = await session({ expectedCharge: { amount: 1500, currency: 'USD' }, discountAmount: 500 }, { unitAmount: 2000 });
      const noCharge = await session({ discountAmount: 0 });
      const bare = await session({});
      const malformed = await session({ expectedCharge: { amount: '1500' }, discountAmount: 12.5 });
      // Ten digits do not fit the column: left alone, not an error that stops the deploy.
      const tooLarge = await session({ expectedCharge: { amount: 12345678901 }, discountAmount: 12345678901 });
      const recurring = await session({ discountAmount: 300 }, { kind: 'RECURRING', unitAmount: 2000 });
      const recurringFull = await session({ discountAmount: 0 }, { kind: 'RECURRING', unitAmount: 2000 });
      // A redirect checkout recorded no discount, so its charge cannot be derived.
      const recurringRedirect = await session({}, { kind: 'RECURRING', unitAmount: 2000 });
      const recurringOverDiscounted = await session({ discountAmount: 2500 }, { kind: 'RECURRING', unitAmount: 2000 });
      const oneTimeNoExpectation = await session({ discountAmount: 300 }, { unitAmount: 2000 });
      // Columns newer code already wrote win over the metadata.
      const written = await session({ expectedCharge: { amount: 1500, currency: 'USD' }, discountAmount: 500 });
      await prisma.checkoutSession.update({ where: { id: written.id }, data: { chargeAmount: 1400, discountAmount: 600 } });
      const writtenRecurring = await session({ discountAmount: 300 }, { kind: 'RECURRING', unitAmount: 2000 });
      await prisma.checkoutSession.update({ where: { id: writtenRecurring.id }, data: { chargeAmount: 1 } });

      await runTwice('money_v2_09_backfill_checkout_amounts');

      const read = (id: string) => prisma.checkoutSession.findUniqueOrThrow({ where: { id } });
      expect(await read(oneTime.id)).toMatchObject({ chargeAmount: 1500, discountAmount: 500 });
      expect(await read(noCharge.id)).toMatchObject({ chargeAmount: null, discountAmount: 0 });
      expect(await read(bare.id)).toMatchObject({ chargeAmount: null, discountAmount: null });
      expect(await read(malformed.id)).toMatchObject({ chargeAmount: null, discountAmount: null });
      expect(await read(tooLarge.id)).toMatchObject({ chargeAmount: null, discountAmount: null });
      expect(await read(recurring.id)).toMatchObject({ chargeAmount: 1700, discountAmount: 300 });
      expect(await read(recurringFull.id)).toMatchObject({ chargeAmount: 2000, discountAmount: 0 });
      expect(await read(recurringRedirect.id)).toMatchObject({ chargeAmount: null, discountAmount: null });
      expect(await read(recurringOverDiscounted.id)).toMatchObject({ chargeAmount: null, discountAmount: 2500 });
      expect(await read(oneTimeNoExpectation.id)).toMatchObject({ chargeAmount: null, discountAmount: 300 });
      expect(await read(written.id)).toMatchObject({ chargeAmount: 1400, discountAmount: 600 });
      expect(await read(writtenRecurring.id)).toMatchObject({ chargeAmount: 1, discountAmount: 300 });
      expect((await read(oneTime.id)).metadata).toEqual(oneTime.metadata);
    });
  });

  describe('coupon amounts (10)', () => {
    it('gives a fixed coupon with a currency one amount row, and nothing to any other', async () => {
      const coupon = (code: string, discountType: 'AMOUNT' | 'PERCENT', amountOff: number, currency: string | null) =>
        prisma.coupon.create({ data: { applicationId, code, discountType, amountOff, currency, planSlugs: [] } });
      const fixed = await coupon('five-off', 'AMOUNT', 500, 'usd');
      const noCurrency = await coupon('legacy', 'AMOUNT', 500, null);
      const percent = await coupon('tenth', 'PERCENT', 1000, null);
      const percentWithCurrency = await coupon('tenth-usd', 'PERCENT', 1000, 'USD');
      const nothingOff = await coupon('nothing', 'AMOUNT', 0, 'USD');
      const malformed = await coupon('tether', 'AMOUNT', 500, 'USDT');

      await runTwice('money_v2_10_backfill_coupon_amounts');

      expect(await prisma.couponAmount.findMany({ where: { applicationId } })).toEqual([
        expect.objectContaining({ couponId: fixed.id, currency: 'USD', amountOff: 500, applicationId }),
      ]);
      const without = [noCurrency.id, percent.id, percentWithCurrency.id, nothingOff.id, malformed.id];
      expect(await prisma.couponAmount.count({ where: { couponId: { in: without } } })).toBe(0);
      expect(await prisma.coupon.findUniqueOrThrow({ where: { id: fixed.id } })).toMatchObject({ amountOff: 500, currency: 'usd' });
    });

    it('keeps an amount an operator has edited since', async () => {
      const fixed = await prisma.coupon.create({
        data: { applicationId, code: 'edited', discountType: 'AMOUNT', amountOff: 500, currency: 'USD', planSlugs: [] },
      });
      await run('money_v2_10_backfill_coupon_amounts');
      await prisma.couponAmount.updateMany({ where: { couponId: fixed.id }, data: { amountOff: 700 } });
      await run('money_v2_10_backfill_coupon_amounts');
      expect(await prisma.couponAmount.findMany({ where: { couponId: fixed.id } })).toEqual([
        expect.objectContaining({ amountOff: 700 }),
      ]);
    });
  });

  describe('provider currencies (11)', () => {
    const credentials = (inApplication: string, provider: string, currencies: string[] = []) =>
      prisma.billingCredentials.create({ data: { applicationId: inApplication, provider, ciphertext: 'x', currencies } });
    const currenciesOf = async (inApplication: string, provider: string) =>
      (await prisma.billingCredentials.findUniqueOrThrow({ where: { applicationId_provider: { applicationId: inApplication, provider } } }))
        .currencies;
    const supportedBy = (provider: string) => getModule(provider)!.display.supportedCurrencies as string[];
    const PAYPAL_DEFAULTS = ['AUD', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'ILS', 'JPY', 'MXN', 'NOK', 'NZD', 'PHP', 'PLN', 'RUB', 'SEK', 'SGD', 'THB', 'TWD', 'USD'];

    /** A subscription on `provider`, with a payment in `paid` when given. */
    async function sold(
      inApplication: string,
      planId: string,
      data: {
        provider: string | null;
        status?: 'ACTIVE' | 'PENDING' | 'CANCELED';
        currency?: string;
        paid?: { currency: string; status: 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED'; provider?: string };
        completedCheckoutOn?: string;
      },
    ): Promise<void> {
      const subscriptionId = await oldSubscription({
        planId,
        applicationId: inApplication,
        status: data.status ?? 'ACTIVE',
        ...(data.provider !== null && { provider: data.provider }),
        ...(data.currency !== undefined && { currency: data.currency, unitAmount: 100 }),
      });
      if (data.paid !== undefined) {
        await prisma.payment.create({
          data: {
            applicationId: inApplication,
            subscriptionId,
            amount: 100,
            currency: data.paid.currency,
            status: data.paid.status,
            ...(data.paid.provider !== undefined && { provider: data.paid.provider }),
          },
        });
      }
      if (data.completedCheckoutOn !== undefined) {
        const row = await subscription(subscriptionId);
        await prisma.checkoutSession.create({
          data: {
            applicationId: inApplication,
            endUserId: row.endUserId,
            subscriptionId,
            provider: data.completedCheckoutOn,
            providerSessionId: `S-${randomUUID().slice(0, 8)}`,
            mode: 'REDIRECT',
            paymentMode: 'TEST',
            kind: 'RECURRING',
            status: 'COMPLETE',
            successUrl: 'https://app.example/ok',
            cancelUrl: 'https://app.example/no',
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
      }
    }

    it('fills an empty list per provider from its defaults and what the account has already sold in', async () => {
      await credentials(applicationId, 'stripe');
      await credentials(applicationId, 'paypal');
      await credentials(applicationId, 'razorpay');
      await credentials(applicationId, 'external');
      const paid = await oldPlan({ amount: 2000 });

      // Razorpay: a paying subscriber in dollars with no payment row yet, and money taken in three other currencies.
      await sold(applicationId, paid.id, { provider: 'razorpay', currency: 'usd' });
      await sold(applicationId, paid.id, { provider: 'razorpay', paid: { currency: 'sgd', status: 'SUCCEEDED' } });
      await sold(applicationId, paid.id, { provider: 'razorpay', paid: { currency: 'EUR', status: 'REFUNDED' } });
      await sold(applicationId, paid.id, { provider: 'razorpay', paid: { currency: 'CAD', status: 'PARTIALLY_REFUNDED' } });
      // None of these is Razorpay taking money in the currency.
      await sold(applicationId, paid.id, { provider: 'razorpay', paid: { currency: 'AED', status: 'FAILED' } });
      await sold(applicationId, paid.id, { provider: 'razorpay', status: 'PENDING', currency: 'CHF' });
      await sold(applicationId, paid.id, { provider: 'razorpay', paid: { currency: 'DKK', status: 'SUCCEEDED', provider: 'stripe' } });
      await sold(applicationId, paid.id, { provider: 'razorpay', paid: { currency: 'US$', status: 'SUCCEEDED' } });
      await sold(applicationId, paid.id, { provider: 'stripe', currency: 'KRW' });
      // PayPal: in-country currencies are claimed only on evidence. One by the payment's own provider, one by a completed checkout.
      await sold(applicationId, paid.id, { provider: null, paid: { currency: 'BRL', status: 'SUCCEEDED', provider: 'paypal' } });
      await sold(applicationId, paid.id, { provider: null, paid: { currency: 'MYR', status: 'SUCCEEDED' }, completedCheckoutOn: 'paypal' });
      await sold(applicationId, paid.id, { provider: 'paypal', paid: { currency: 'GBP', status: 'SUCCEEDED' } });

      await runTwice('money_v2_11_backfill_provider_currencies');

      expect(await currenciesOf(applicationId, 'razorpay')).toEqual(['CAD', 'EUR', 'INR', 'SGD', 'USD']);
      expect(await currenciesOf(applicationId, 'paypal')).toEqual([...PAYPAL_DEFAULTS, 'BRL', 'MYR'].sort());

      const stripe = await currenciesOf(applicationId, 'stripe');
      expect(stripe.length).toBeGreaterThan(100);
      expect(stripe).toEqual(expect.arrayContaining(['USD', 'INR', 'JPY', 'ISK', 'HUF']));
      expect(stripe.filter((code) => !supportedBy('stripe').includes(code))).toEqual([]);
      expect(stripe).not.toContain('KWD');
    });

    it('gives every other provider every currency a price may be in: the external module, a module it does not know, a null list and a disabled row', async () => {
      const other = await newApplication();
      await credentials(applicationId, 'external');
      await credentials(applicationId, 'mollie');
      await credentials(other, 'external');
      await credentials(other, 'mollie');
      await prisma.$executeRaw`UPDATE "billing_credentials" SET "currencies" = NULL WHERE "application_id" = ${other}`;
      await prisma.billingCredentials.updateMany({ where: { applicationId: other, provider: 'mollie' }, data: { enabled: false } });

      await runTwice('money_v2_11_backfill_provider_currencies');

      const external = await currenciesOf(applicationId, 'external');
      expect(external.length).toBeGreaterThan(100);
      expect(external).toEqual(expect.arrayContaining(['USD', 'INR', 'IRR', 'JPY']));
      expect(external.filter((code) => CURRENCY_TABLE[code] === undefined || !isSellableCurrency(code))).toEqual([]);
      expect(external).not.toContain('KWD');
      for (const [inApplication, provider] of [[applicationId, 'mollie'], [other, 'external'], [other, 'mollie']] as const) {
        expect(await currenciesOf(inApplication, provider), `${provider} in ${inApplication}`).toEqual(external);
      }
    });

    it('leaves no row without a currency, whatever its provider', async () => {
      for (const provider of ['stripe', 'paypal', 'razorpay', 'external', 'mollie']) await credentials(applicationId, provider);

      await run('money_v2_11_backfill_provider_currencies');

      const rows = await prisma.billingCredentials.findMany({ where: { applicationId } });
      expect(rows).toHaveLength(5);
      expect(rows.filter((row) => row.currencies.length === 0).map((row) => row.provider)).toEqual([]);
    });

    it('claims by default only what the provider module supports', async () => {
      await credentials(applicationId, 'paypal');
      await credentials(applicationId, 'razorpay');

      await run('money_v2_11_backfill_provider_currencies');

      const paypal = await currenciesOf(applicationId, 'paypal');
      expect(paypal).toEqual(PAYPAL_DEFAULTS);
      expect(paypal.every((code) => supportedBy('paypal').includes(code))).toBe(true);
      for (const inCountryOnly of ['BRL', 'CNY', 'MYR']) expect(paypal).not.toContain(inCountryOnly);
      const razorpay = await currenciesOf(applicationId, 'razorpay');
      expect(razorpay).toEqual(['INR']);
      expect(razorpay.every((code) => supportedBy('razorpay').includes(code))).toBe(true);
    });

    it('reads only the row own Application, and treats a null list as empty', async () => {
      const other = await newApplication();
      for (const provider of ['stripe', 'paypal', 'razorpay']) {
        await credentials(applicationId, provider);
        await credentials(other, provider);
      }
      await prisma.$executeRaw`UPDATE "billing_credentials" SET "currencies" = NULL WHERE "application_id" = ${other}`;
      const here = await oldPlan({ amount: 2000 });
      const there = await oldPlan({ amount: 2000, applicationId: other });
      await sold(applicationId, here.id, { provider: 'razorpay', currency: 'USD', paid: { currency: 'SGD', status: 'SUCCEEDED' } });
      await sold(applicationId, here.id, { provider: 'paypal', paid: { currency: 'BRL', status: 'SUCCEEDED' } });
      await sold(other, there.id, { provider: 'razorpay', currency: 'EUR', paid: { currency: 'AUD', status: 'SUCCEEDED' } });
      await sold(other, there.id, { provider: 'paypal', paid: { currency: 'MYR', status: 'SUCCEEDED' } });
      // A payment here that points at a Razorpay subscription there, and one whose only checkout is filed there.
      const thereOnRazorpay = await oldSubscription({ planId: there.id, applicationId: other, provider: 'razorpay' });
      await prisma.payment.create({ data: { applicationId, subscriptionId: thereOnRazorpay, amount: 100, currency: 'NOK', status: 'SUCCEEDED' } });
      const hereNoProvider = await oldSubscription({ planId: here.id });
      await prisma.payment.create({ data: { applicationId, subscriptionId: hereNoProvider, amount: 100, currency: 'SEK', status: 'SUCCEEDED' } });
      await prisma.checkoutSession.create({
        data: {
          applicationId: other,
          endUserId: await newEndUser(other),
          subscriptionId: hereNoProvider,
          provider: 'razorpay',
          providerSessionId: 'S-across',
          mode: 'REDIRECT',
          paymentMode: 'TEST',
          kind: 'RECURRING',
          status: 'COMPLETE',
          successUrl: 'https://app.example/ok',
          cancelUrl: 'https://app.example/no',
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await runTwice('money_v2_11_backfill_provider_currencies');

      expect(await currenciesOf(applicationId, 'razorpay')).toEqual(['INR', 'SGD', 'USD']);
      expect(await currenciesOf(other, 'razorpay')).toEqual(['AUD', 'EUR', 'INR']);
      expect(await currenciesOf(applicationId, 'paypal')).toEqual([...PAYPAL_DEFAULTS, 'BRL'].sort());
      expect(await currenciesOf(other, 'paypal')).toEqual([...PAYPAL_DEFAULTS, 'MYR'].sort());
      expect((await currenciesOf(other, 'stripe')).length).toBeGreaterThan(100);
    });

    it('never widens a list an operator chose', async () => {
      await credentials(applicationId, 'external', ['GBP']);
      await credentials(applicationId, 'mollie', ['SEK']);
      await credentials(applicationId, 'stripe', ['EUR']);
      await credentials(applicationId, 'paypal', ['USD']);
      await credentials(applicationId, 'razorpay', ['INR']);
      const paid = await oldPlan({ amount: 2000 });
      await sold(applicationId, paid.id, { provider: 'razorpay', currency: 'USD', paid: { currency: 'SGD', status: 'SUCCEEDED' } });
      await sold(applicationId, paid.id, { provider: 'paypal', currency: 'GBP', paid: { currency: 'BRL', status: 'SUCCEEDED' } });

      await runTwice('money_v2_11_backfill_provider_currencies');

      expect(await currenciesOf(applicationId, 'external')).toEqual(['GBP']);
      expect(await currenciesOf(applicationId, 'mollie')).toEqual(['SEK']);
      expect(await currenciesOf(applicationId, 'stripe')).toEqual(['EUR']);
      expect(await currenciesOf(applicationId, 'paypal')).toEqual(['USD']);
      expect(await currenciesOf(applicationId, 'razorpay')).toEqual(['INR']);
    });
  });

  describe('refunds (12)', () => {
    it('gives a payment with a refunded total one refund row, saying who started it only where that is on record', async () => {
      const pay = (data: { status: 'SUCCEEDED' | 'REFUNDED' | 'PARTIALLY_REFUNDED'; refundedAmount: number; currency?: string; metadata?: object }) =>
        prisma.payment.create({
          data: { applicationId, amount: 2000, currency: data.currency ?? 'usd', status: data.status, refundedAmount: data.refundedAmount, metadata: data.metadata ?? {} },
        });
      const refundedCase = (paymentId: string) =>
        prisma.unappliedPayment.create({
          data: {
            applicationId,
            paymentId,
            provider: 'stripe',
            amount: 2000,
            currency: 'USD',
            status: 'REFUNDED',
            providerRefundId: `re_${paymentId}`,
            resolutionNote: 'Charged twice',
            resolvedAt: new Date('2026-09-01T10:00:00.000Z'),
          },
        });
      const byProvider = await pay({ status: 'PARTIALLY_REFUNDED', refundedAmount: 400, metadata: { refundEvents: ['evt_1'] } });
      const byOperator = await pay({ status: 'REFUNDED', refundedAmount: 2000 });
      await refundedCase(byOperator.id);
      // Refunded through its case and again at the provider: the total is not one refund, so it carries no refund id.
      const mixed = await pay({ status: 'REFUNDED', refundedAmount: 2000, metadata: { refundEvents: ['evt_2'] } });
      await refundedCase(mixed.id);
      const dismissed = await pay({ status: 'PARTIALLY_REFUNDED', refundedAmount: 100 });
      await prisma.unappliedPayment.create({
        data: { applicationId, paymentId: dismissed.id, provider: 'paypal', amount: 2000, currency: 'USD', status: 'DISMISSED', providerRefundId: 'not-a-rekey-refund' },
      });
      const caseElsewhere = await pay({ status: 'REFUNDED', refundedAmount: 2000 });
      await prisma.unappliedPayment.create({
        data: { applicationId: await newApplication(), paymentId: caseElsewhere.id, provider: 'stripe', amount: 2000, currency: 'USD', status: 'REFUNDED', providerRefundId: 're_elsewhere' },
      });
      const notRefunded = await pay({ status: 'SUCCEEDED', refundedAmount: 0 });
      const refundedWithoutAmount = await pay({ status: 'REFUNDED', refundedAmount: 0 });
      const malformed = await pay({ status: 'PARTIALLY_REFUNDED', refundedAmount: 100, currency: 'USDT' });
      // Newer code has already recorded this payment's refund as a row.
      const recorded = await pay({ status: 'PARTIALLY_REFUNDED', refundedAmount: 300 });
      await prisma.refund.create({
        data: { applicationId, paymentId: recorded.id, amount: 300, currency: 'USD', status: 'SUCCEEDED', initiatedBy: 'SYSTEM' },
      });

      await runTwice('money_v2_12_backfill_refunds');

      const refundsOf = (paymentId: string) => prisma.refund.findMany({ where: { paymentId } });
      expect(await refundsOf(byProvider.id)).toEqual([
        expect.objectContaining({
          applicationId,
          amount: 400,
          currency: 'USD',
          status: 'SUCCEEDED',
          initiatedBy: 'PROVIDER',
          providerRefundId: null,
          reason: null,
          createdAt: (await prisma.payment.findUniqueOrThrow({ where: { id: byProvider.id } })).updatedAt,
        }),
      ]);
      expect(await refundsOf(byOperator.id)).toEqual([
        expect.objectContaining({
          amount: 2000,
          initiatedBy: 'OPERATOR',
          providerRefundId: `re_${byOperator.id}`,
          reason: 'Charged twice',
          createdAt: new Date('2026-09-01T10:00:00.000Z'),
        }),
      ]);
      expect(await refundsOf(mixed.id)).toEqual([
        expect.objectContaining({ amount: 2000, initiatedBy: 'OPERATOR', providerRefundId: null }),
      ]);
      expect(await refundsOf(dismissed.id)).toEqual([
        expect.objectContaining({ amount: 100, initiatedBy: 'PROVIDER', providerRefundId: null, reason: null }),
      ]);
      expect(await refundsOf(caseElsewhere.id)).toEqual([
        expect.objectContaining({ amount: 2000, initiatedBy: 'PROVIDER', providerRefundId: null }),
      ]);
      expect(await refundsOf(recorded.id)).toEqual([expect.objectContaining({ amount: 300, initiatedBy: 'SYSTEM' })]);
      for (const without of [notRefunded, refundedWithoutAmount, malformed]) expect(await refundsOf(without.id)).toEqual([]);
    });
  });

  describe('credit purchases (13)', () => {
    it('names the payment on a purchase row whose key says which one, inside its own Application', async () => {
      const other = await newApplication();
      const paid = await oldPlan({ amount: 2000, currency: 'USD' });
      await run('money_v2_04_backfill_default_prices');
      const defaultPriceId = (await plan(paid.id)).defaultPriceId!;
      const priced = await prisma.payment.create({
        data: { applicationId, amount: 2000, currency: 'USD', status: 'SUCCEEDED', planPriceId: defaultPriceId },
      });
      const unpriced = await prisma.payment.create({ data: { applicationId, amount: 2000, currency: 'USD', status: 'SUCCEEDED' } });
      const kase = await prisma.unappliedPayment.create({
        data: { applicationId, paymentId: unpriced.id, provider: 'stripe', amount: 2000, currency: 'USD', status: 'ENTITLEMENT_GRANTED' },
      });
      const foreignPayment = await prisma.payment.create({ data: { applicationId: other, amount: 2000, currency: 'USD', status: 'SUCCEEDED' } });
      const foreignCase = await prisma.unappliedPayment.create({
        data: { applicationId: other, paymentId: foreignPayment.id, provider: 'stripe', amount: 2000, currency: 'USD', status: 'ENTITLEMENT_GRANTED' },
      });
      let subject = 0;
      const entry = (idempotencyKey: string | null, data: { reason?: 'PURCHASE' | 'GRANT'; paymentId?: string } = {}) => {
        subject += 1;
        return prisma.creditLedger.create({
          data: { applicationId, subjectKey: `u:user_${subject}`, delta: 100, balanceAfter: 100, reason: data.reason ?? 'PURCHASE', idempotencyKey, ...(data.paymentId !== undefined && { paymentId: data.paymentId }) },
        });
      };
      const direct = await entry(`purchase:${priced.id}`);
      const throughCase = await entry(`purchase:ent:sub_1:CREDIT:base:unapplied:${kase.id}`);
      const bySession = await entry('purchase:ent:sub_1:CREDIT:base:cs_test_123');
      const byPeriod = await entry('purchase:ent:sub_1:CREDIT:base:initial');
      const unkeyed = await entry(null);
      const notAPurchase = await entry(`purchase:${priced.id}`, { reason: 'GRANT' });
      const otherApplicationPayment = await entry(`purchase:${foreignPayment.id}`);
      const otherApplicationCase = await entry(`purchase:ent:sub_1:CREDIT:base:unapplied:${foreignCase.id}`);
      const written = await entry(`purchase:${priced.id}`, { paymentId: unpriced.id });
      const writtenThroughCase = await entry(`purchase:ent:sub_2:CREDIT:base:unapplied:${kase.id}`, { paymentId: priced.id });

      await runTwice('money_v2_13_backfill_credit_payments');

      const read = (id: string) => prisma.creditLedger.findUniqueOrThrow({ where: { id } });
      expect(await read(direct.id)).toMatchObject({ paymentId: priced.id, planPriceId: defaultPriceId });
      expect(await read(throughCase.id)).toMatchObject({ paymentId: unpriced.id, planPriceId: null });
      const untouched = { paymentId: null, planPriceId: null };
      for (const row of [bySession, byPeriod, unkeyed, notAPurchase, otherApplicationPayment, otherApplicationCase]) {
        expect(await read(row.id)).toMatchObject(untouched);
      }
      expect(await read(written.id)).toMatchObject({ paymentId: unpriced.id, planPriceId: null });
      expect(await read(writtenThroughCase.id)).toMatchObject({ paymentId: priced.id, planPriceId: null });
    });
  });

  it('every backfill is a data-only migration: no DDL', () => {
    for (const suffix of BACKFILLS) {
      const sql = migrationSql(suffix)
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      expect(sql, suffix).not.toMatch(/\b(ALTER|CREATE|DROP)\b/);
    }
  });
});
