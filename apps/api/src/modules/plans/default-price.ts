/**
 * The one place a plan's price columns are read or written.
 *
 * A plan's default price is the `PlanPrice` row `Plan.defaultPriceId` names,
 * and every reader takes the price from that row. `Plan.amount`,
 * `Plan.currency` and `Plan.pricePerUnitCents` are still written here, in the
 * same transaction as the row, so an API from before the row existed keeps
 * working while a deploy rolls out. Nothing outside this file reads them:
 * `test/money-source-scan.test.ts` checks the source tree.
 *
 * A plan another build wrote (or a row somebody edited by hand) is brought
 * back in step the first time it is read through `withDefaultPrices`.
 */

import { Prisma as PrismaSql, type Plan, type PlanPrice, type Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { openCheckout } from './price-usage.js';

/** The keys of `Plan.metadata` that hold a provider's registration. */
export const PROVIDER_REGISTRATION_KEYS = ['stripe', 'paypal', 'razorpay'] as const;

/** A plan with the price row its `defaultPriceId` names: null for a plan with no flat price. */
export type PlanWithDefaultPrice = Plan & { defaultPrice: PlanPrice | null };

/** The Prisma `include` that loads a plan's default price with it. */
export const WITH_DEFAULT_PRICE = { defaultPrice: true } as const satisfies Prisma.PlanInclude;

type Db = Prisma.TransactionClient;

function registrationsOf(metadata: Prisma.JsonValue): Prisma.JsonObject {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return {};
  const kept: Prisma.JsonObject = {};
  for (const key of PROVIDER_REGISTRATION_KEYS) {
    const entry = metadata[key];
    if (entry !== undefined) kept[key] = entry;
  }
  return kept;
}

/** Key order is not part of a JSON value, and Postgres does not keep the order it was written in. */
function canonical(value: Prisma.JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter((entry): entry is [string, Prisma.JsonValue] => entry[1] !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function chargesNothing(plan: Pick<Plan, 'amount' | 'pricePerUnitCents'>): boolean {
  return plan.amount === 0 && plan.pricePerUnitCents === null;
}

/** What the default price row has to say for it to agree with the plan's own columns. */
function mirrorOf(plan: Plan) {
  return {
    amount: plan.amount,
    metadata: registrationsOf(plan.metadata),
    registrationStatus: plan.registrationStatus,
    registrationError: plan.registrationError,
  };
}

/**
 * The currency stored on a priced plan when it is not three letters, or null.
 * The API never writes one; a direct database write can. No price row can be
 * made for it, so such a plan is left as it is and reported to its operator
 * instead of failing every read that meets it.
 *
 * @example
 * malformedPlanCurrency(plan); // 'dollars', or null for a plan that can be priced
 */
export function malformedPlanCurrency(plan: Pick<Plan, 'amount' | 'currency'>): string | null {
  if (plan.amount <= 0) return null;
  return /^[A-Z]{3}$/.test(plan.currency.toUpperCase()) ? null : plan.currency;
}

function inStep(plan: Plan, row: PlanPrice | null): boolean {
  if (malformedPlanCurrency(plan) !== null) return true;
  if (plan.isFree !== chargesNothing(plan)) return false;
  if (plan.amount <= 0) return plan.defaultPriceId === null;
  if (row === null || row.id !== plan.defaultPriceId || row.archivedAt !== null) return false;
  const mirrored = mirrorOf(plan);
  return (
    row.currency === plan.currency.toUpperCase() &&
    row.amount === mirrored.amount &&
    row.registrationStatus === mirrored.registrationStatus &&
    row.registrationError === mirrored.registrationError &&
    canonical(row.metadata) === canonical(mirrored.metadata)
  );
}

async function isReferenced(db: Db, priceId: string): Promise<boolean> {
  const [subscription, payment, ledger, checkout] = await Promise.all([
    db.subscription.findFirst({ where: { planPriceId: priceId }, select: { id: true } }),
    db.payment.findFirst({ where: { planPriceId: priceId }, select: { id: true } }),
    db.creditLedger.findFirst({ where: { planPriceId: priceId }, select: { id: true } }),
    db.checkoutSession.findFirst({ where: { planPriceId: priceId, ...openCheckout(new Date()) }, select: { id: true } }),
  ]);
  return subscription !== null || payment !== null || ledger !== null || checkout !== null;
}

/**
 * Take a price off sale: archive it when a subscription, a payment, a credit
 * grant or an open checkout refers to it, and delete it otherwise.
 *
 * @example
 * await retirePlanPrice(tx, price.id);
 */
export async function retirePlanPrice(db: Db, priceId: string): Promise<'archived' | 'deleted'> {
  if (await isReferenced(db, priceId)) {
    await db.planPrice.update({ where: { id: priceId }, data: { archivedAt: new Date() } });
    return 'archived';
  }
  await db.planPrice.delete({ where: { id: priceId } });
  return 'deleted';
}

async function livePriceIn(db: Db, planId: string, currency: string): Promise<PlanPrice | null> {
  return db.planPrice.findFirst({ where: { planId, currency, archivedAt: null } });
}

/** What a sync did to the default price, for the billing log. */
export interface DefaultPriceChange {
  before: PlanPrice | null;
  after: PlanPrice | null;
  /** What became of `before` when it stopped being the default. */
  retired: 'archived' | 'deleted' | null;
}

async function sync(db: Db, plan: Plan): Promise<{ plan: PlanWithDefaultPrice; change: DefaultPriceChange }> {
  const isFree = chargesNothing(plan);
  const current =
    plan.defaultPriceId === null ? null : await db.planPrice.findUnique({ where: { id: plan.defaultPriceId } });
  if (malformedPlanCurrency(plan) !== null) {
    return { plan: { ...plan, defaultPrice: current }, change: { before: current, after: current, retired: null } };
  }

  if (plan.amount <= 0) {
    if (plan.defaultPriceId === null && plan.isFree === isFree) {
      return { plan: { ...plan, defaultPrice: null }, change: { before: null, after: null, retired: null } };
    }
    const unpriced = await db.plan.update({ where: { id: plan.id }, data: { defaultPriceId: null, isFree } });
    const retired = current === null ? null : await retirePlanPrice(db, current.id);
    return { plan: { ...unpriced, defaultPrice: null }, change: { before: current, after: null, retired } };
  }

  const currency = plan.currency.toUpperCase();
  const mirrored = mirrorOf(plan);
  const repriced = current !== null && (current.currency !== currency || current.amount !== plan.amount);
  const keepsRow =
    current !== null && current.archivedAt === null && !(repriced && (await isReferenced(db, current.id)));

  let after: PlanPrice;
  let retired: DefaultPriceChange['retired'] = null;
  if (current !== null && keepsRow && current.currency === currency) {
    const agrees =
      current.amount === mirrored.amount &&
      current.registrationStatus === mirrored.registrationStatus &&
      current.registrationError === mirrored.registrationError &&
      canonical(current.metadata) === canonical(mirrored.metadata);
    after = agrees ? current : await db.planPrice.update({ where: { id: current.id }, data: mirrored });
  } else {
    if (current !== null) {
      await db.plan.update({ where: { id: plan.id }, data: { defaultPriceId: null } });
      retired = await retirePlanPrice(db, current.id);
    }
    // `skipDuplicates` is ON CONFLICT DO NOTHING: two requests pricing the
    // same plan at once must not abort the transaction either of them is in.
    await db.planPrice.createMany({
      data: [{ applicationId: plan.applicationId, planId: plan.id, currency, ...mirrored }],
      skipDuplicates: true,
    });
    const live = await livePriceIn(db, plan.id, currency);
    if (live === null) throw new Error(`Plan ${plan.id} has no live ${currency} price after one was written.`);
    after = await db.planPrice.update({ where: { id: live.id }, data: mirrored });
  }

  const settled =
    plan.defaultPriceId === after.id && plan.isFree === isFree
      ? plan
      : await db.plan.update({ where: { id: plan.id }, data: { defaultPriceId: after.id, isFree } });
  return { plan: { ...settled, defaultPrice: after }, change: { before: current, after, retired } };
}

/**
 * Make the plan's default price row say what the plan's columns say, and
 * return the plan with that row. Changes nothing when they already agree.
 *
 * A plan with no flat amount has no default price. A default price that
 * something refers to is archived and replaced when its amount or currency
 * changes, so what a subscriber was charged stays on record.
 *
 * @example
 * const plan = await syncDefaultPrice(tx, await tx.plan.findUniqueOrThrow({ where: { id } }));
 * plan.defaultPrice?.amount; // what a buyer with no other price pays
 */
export async function syncDefaultPrice(db: Db, plan: Plan): Promise<PlanWithDefaultPrice> {
  return (await sync(db, plan)).plan;
}

/**
 * Create a plan and its default price row together.
 *
 * @example
 * const plan = await createPlanWithDefaultPrice({ applicationId, slug: 'pro', name: 'Pro', amount: 2000, currency: 'USD' });
 */
export async function createPlanWithDefaultPrice(
  data: Prisma.PlanUncheckedCreateInput,
  db?: Db,
): Promise<PlanWithDefaultPrice> {
  const write = async (tx: Db) => syncDefaultPrice(tx, await tx.plan.create({ data }));
  return db === undefined ? prisma.$transaction(write) : write(db);
}

/**
 * Update a plan and its default price row together. `onChange` runs in the
 * same transaction with what happened to the default price and with the plan
 * as it was before, which is where a billing event for the change is written.
 *
 * @example
 * const plan = await updatePlanAndDefaultPrice(planId, { registrationStatus: 'REGISTERED' });
 */
export async function updatePlanAndDefaultPrice(
  planId: string,
  data: Prisma.PlanUpdateInput,
  onChange?: (tx: Db, plan: PlanWithDefaultPrice, change: DefaultPriceChange, previous: Plan) => Promise<void>,
): Promise<PlanWithDefaultPrice> {
  return prisma.$transaction(async (tx) => {
    if (onChange === undefined) return (await sync(tx, await tx.plan.update({ where: { id: planId }, data }))).plan;
    // Locked before it is read: the "before" a caller logs has to be the row
    // this write replaced, not one a concurrent write has already replaced.
    await tx.$queryRaw`SELECT 1 FROM "plans" WHERE "id" = ${planId} FOR NO KEY UPDATE`;
    const previous = await tx.plan.findUniqueOrThrow({ where: { id: planId } });
    const { plan, change } = await sync(tx, await tx.plan.update({ where: { id: planId }, data }));
    await onChange(tx, plan, change, previous);
    return plan;
  });
}

/**
 * The plan columns that say what the default price is: the price given, or
 * no flat price for null. The currency column is left as it is for a plan
 * with no flat price, which has no currency of its own.
 *
 * @example
 * await updatePlanAndDefaultPrice(plan.id, defaultPriceColumns({ currency: 'USD', amount: 1900 }));
 */
export function defaultPriceColumns(price: { currency: string; amount: number } | null): { amount: number; currency?: string } {
  return price === null ? { amount: 0 } : { amount: price.amount, currency: price.currency };
}

/**
 * Written on a USAGE plan when it is created. A metered plan is not free even
 * with no base fee, and until the column is dropped `isFree` is worked out
 * from it. The figure itself is charged by nothing.
 */
export const METERED_PLAN_COLUMNS = { pricePerUnitCents: 0 } as const;

type MaybeLoaded = Plan & { defaultPrice?: PlanPrice | null };

/**
 * The same plans, each with its default price row. One read for the rows not
 * already loaded, and a write only for a plan that is out of step.
 *
 * @example
 * const plans = await withDefaultPrices(await prisma.plan.findMany({ where: { applicationId } }));
 */
export async function withDefaultPrices<T extends MaybeLoaded>(
  plans: readonly T[],
  db: Db = prisma,
): Promise<Array<T & PlanWithDefaultPrice>> {
  const missing = plans.flatMap((plan) =>
    plan.defaultPrice === undefined && plan.defaultPriceId !== null ? [plan.defaultPriceId] : [],
  );
  const loaded = new Map(
    missing.length === 0
      ? []
      : (await db.planPrice.findMany({ where: { id: { in: missing } } })).map((row) => [row.id, row] as const),
  );
  const out: Array<T & PlanWithDefaultPrice> = [];
  for (const plan of plans) {
    const row =
      plan.defaultPrice !== undefined
        ? plan.defaultPrice
        : plan.defaultPriceId === null
          ? null
          : (loaded.get(plan.defaultPriceId) ?? null);
    if (inStep(plan, row)) {
      out.push({ ...plan, defaultPrice: row });
      continue;
    }
    // Any read can land here, so two can at once. The second waits for the
    // first, then finds the plan in step and writes nothing. Without the lock
    // both retire the same stale row and the slower one fails. FOR NO KEY
    // UPDATE and not FOR UPDATE: a price row being inserted for this plan
    // holds a key-share lock on it, which FOR UPDATE would deadlock against.
    const repair = async (tx: Db) => {
      await tx.$queryRaw`SELECT 1 FROM "plans" WHERE "id" = ${plan.id} FOR NO KEY UPDATE`;
      return syncDefaultPrice(tx, await tx.plan.findUniqueOrThrow({ where: { id: plan.id } }));
    };
    const root = db as Db & { $transaction?: typeof prisma.$transaction };
    const repaired = typeof root.$transaction === 'function' ? await root.$transaction(repair) : await repair(db);
    out.push({ ...plan, ...repaired });
  }
  return out;
}

/**
 * The default price row of each plan named, keyed by plan id: null for a plan
 * with no flat price.
 *
 * @example
 * const defaults = await defaultPricesByPlan(subscriptions.map((sub) => sub.planId));
 */
export async function defaultPricesByPlan(planIds: readonly string[]): Promise<Map<string, PlanPrice | null>> {
  const ids = [...new Set(planIds)];
  if (ids.length === 0) return new Map();
  const plans = await withDefaultPrices(
    await prisma.plan.findMany({ where: { id: { in: ids } }, include: WITH_DEFAULT_PRICE }),
  );
  return new Map(plans.map((plan) => [plan.id, plan.defaultPrice]));
}

/**
 * Bring every plan that is out of step back in step, for a reader that
 * aggregates in SQL and so never loads a plan through `withDefaultPrices`.
 * One indexed read when nothing is out of step. `applicationIds` undefined
 * means every Application.
 *
 * @example
 * await bringPlansInStep([applicationId]);
 */
export async function bringPlansInStep(applicationIds?: readonly string[], db: Db = prisma): Promise<void> {
  if (applicationIds !== undefined && applicationIds.length === 0) return;
  const scope = applicationIds === undefined ? PrismaSql.empty : PrismaSql.sql`AND p."application_id" = ANY(${[...applicationIds]}::text[])`;
  const stale = await db.$queryRaw<Array<{ id: string }>>(PrismaSql.sql`
    SELECT p."id" FROM "plans" AS p
      LEFT JOIN "plan_prices" AS dp ON dp."id" = p."default_price_id"
     WHERE (p."is_free" <> (p."amount" = 0 AND p."price_per_unit_cents" IS NULL)
            OR (p."amount" > 0) <> (p."default_price_id" IS NOT NULL)
            OR (dp."id" IS NOT NULL AND (dp."amount" <> p."amount" OR dp."currency" <> upper(p."currency") OR dp."archived_at" IS NOT NULL)))
       AND (p."amount" <= 0 OR upper(p."currency") ~ '^[A-Z]{3}$')
       ${scope}
     LIMIT 500`);
  if (stale.length === 0) return;
  // Repaired on a connection of its own: the caller's may be a read-only
  // transaction, and its next statement sees what this committed.
  await withDefaultPrices(await prisma.plan.findMany({ where: { id: { in: stale.map((row) => row.id) } } }));
}

/**
 * One plan with its default price row.
 *
 * @example
 * const plan = await withDefaultPrice(await prisma.plan.findUniqueOrThrow({ where: { id } }));
 */
export async function withDefaultPrice<T extends MaybeLoaded>(plan: T, db: Db = prisma): Promise<T & PlanWithDefaultPrice> {
  const [priced] = await withDefaultPrices([plan], db);
  return priced!;
}
