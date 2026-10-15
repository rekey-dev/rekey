/**
 * The one place a plan's default price is written.
 *
 * A plan's price is the `PlanPrice` row `Plan.defaultPriceId` names, and
 * nowhere else. A plan with no flat price (free, or metered with no base fee)
 * has no row, and `Plan.isFree` says which of the two it is.
 *
 * The plan's provider registration (`registrationStatus`,
 * `registrationError` and the provider keys of `metadata`) is copied onto the
 * default price row in the same transaction as every plan write, because a
 * price is what a provider registers.
 */

import type { Plan, PlanPrice, Prisma } from '@prisma/client';
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

/** A flat price as a caller gives it: an ISO 4217 code and minor units. */
export interface DefaultPriceInput {
  currency: string;
  amount: number;
}

/** What the default price row copies from its plan. */
function registrationOf(plan: Plan) {
  return {
    metadata: registrationsOf(plan.metadata),
    registrationStatus: plan.registrationStatus,
    registrationError: plan.registrationError,
  };
}

function carries(row: PlanPrice, registration: ReturnType<typeof registrationOf>): boolean {
  return (
    row.registrationStatus === registration.registrationStatus &&
    row.registrationError === registration.registrationError &&
    canonical(row.metadata) === canonical(registration.metadata)
  );
}

/**
 * Whether a plan with no flat price charges nothing at all. A metered plan
 * bills usage, so it is not free even with no base fee.
 *
 * @example
 * unpricedPlanIsFree('USAGE'); // false
 */
export function unpricedPlanIsFree(kind: Plan['kind']): boolean {
  return kind !== 'USAGE';
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

/**
 * Bring the default price row in line with a plan that was just written.
 * `price` undefined leaves the price as it is and copies the registration
 * only; null takes the flat price away; a value sets it.
 */
async function settle(
  db: Db,
  plan: Plan,
  price: DefaultPriceInput | null | undefined,
): Promise<{ plan: PlanWithDefaultPrice; change: DefaultPriceChange }> {
  const current =
    plan.defaultPriceId === null ? null : await db.planPrice.findUnique({ where: { id: plan.defaultPriceId } });
  const registration = registrationOf(plan);

  if (price === undefined || (price === null && current === null)) {
    const after =
      current === null || carries(current, registration)
        ? current
        : await db.planPrice.update({ where: { id: current.id }, data: registration });
    return { plan: { ...plan, defaultPrice: after }, change: { before: current, after, retired: null } };
  }

  if (price === null) {
    const unpriced = await db.plan.update({
      where: { id: plan.id },
      data: { defaultPriceId: null, isFree: unpricedPlanIsFree(plan.kind) },
    });
    const retired = current === null ? null : await retirePlanPrice(db, current.id);
    return { plan: { ...unpriced, defaultPrice: null }, change: { before: current, after: null, retired } };
  }

  const currency = price.currency.toUpperCase();
  const row = { amount: price.amount, ...registration };
  const repriced = current !== null && (current.currency !== currency || current.amount !== price.amount);
  const keepsRow = current !== null && !(repriced && (await isReferenced(db, current.id)));

  let after: PlanPrice;
  let retired: DefaultPriceChange['retired'] = null;
  if (current !== null && keepsRow && current.currency === currency) {
    after =
      current.amount === row.amount && carries(current, registration)
        ? current
        : await db.planPrice.update({ where: { id: current.id }, data: row });
  } else {
    if (current !== null) {
      await db.plan.update({ where: { id: plan.id }, data: { defaultPriceId: null } });
      retired = await retirePlanPrice(db, current.id);
    }
    // `skipDuplicates` is ON CONFLICT DO NOTHING: two requests pricing the
    // same plan at once must not abort the transaction either of them is in.
    await db.planPrice.createMany({
      data: [{ applicationId: plan.applicationId, planId: plan.id, currency, ...row }],
      skipDuplicates: true,
    });
    const live = await livePriceIn(db, plan.id, currency);
    if (live === null) throw new Error(`Plan ${plan.id} has no live ${currency} price after one was written.`);
    after = await db.planPrice.update({ where: { id: live.id }, data: row });
  }

  const settled =
    plan.defaultPriceId === after.id && !plan.isFree
      ? plan
      : await db.plan.update({ where: { id: plan.id }, data: { defaultPriceId: after.id, isFree: false } });
  return { plan: { ...settled, defaultPrice: after }, change: { before: current, after, retired } };
}

/** A plan's own columns at creation. Its price and whether it is free come from the `price` argument. */
export type PlanCreateData = Omit<Prisma.PlanUncheckedCreateInput, 'defaultPriceId' | 'isFree'>;

/**
 * Create a plan and, when it has a flat price, its default price row.
 *
 * @example
 * const plan = await createPlanWithDefaultPrice({ applicationId, slug: 'pro', name: 'Pro' }, { currency: 'USD', amount: 2000 });
 * const free = await createPlanWithDefaultPrice({ applicationId, slug: 'free', name: 'Free' }, null);
 */
export async function createPlanWithDefaultPrice(
  data: PlanCreateData,
  price: DefaultPriceInput | null,
  db?: Db,
): Promise<PlanWithDefaultPrice> {
  const write = async (tx: Db) => {
    const isFree = price === null && unpricedPlanIsFree(data.kind ?? 'SUBSCRIPTION');
    return (await settle(tx, await tx.plan.create({ data: { ...data, isFree } }), price)).plan;
  };
  return db === undefined ? prisma.$transaction(write) : write(db);
}

/** A change to a plan's own columns. Its price is changed through `price`. */
export type PlanUpdateData = Omit<Prisma.PlanUpdateInput, 'defaultPrice' | 'isFree' | 'prices'>;

/**
 * Update a plan and its default price row together. `price` undefined leaves
 * the price alone, null takes the flat price away. `onChange` runs in the
 * same transaction with what happened to the default price and with the plan
 * as it was before, which is where a billing event for the change is written.
 *
 * A default price that something refers to is archived and replaced when its
 * amount or currency changes, so what a subscriber was charged stays on
 * record.
 *
 * @example
 * const plan = await updatePlanAndDefaultPrice(planId, { registrationStatus: 'REGISTERED' });
 * const repriced = await updatePlanAndDefaultPrice(planId, {}, { price: { currency: 'USD', amount: 1900 } });
 */
export async function updatePlanAndDefaultPrice(
  planId: string,
  data: PlanUpdateData,
  options: {
    price?: DefaultPriceInput | null;
    onChange?: (tx: Db, plan: PlanWithDefaultPrice, change: DefaultPriceChange, previous: Plan) => Promise<void>;
  } = {},
): Promise<PlanWithDefaultPrice> {
  const { price, onChange } = options;
  return prisma.$transaction(async (tx) => {
    // Locked before it is read: the "before" a caller logs has to be the row
    // this write replaced, and two writes pricing one plan must not both
    // retire the same default price. FOR NO KEY UPDATE and not FOR UPDATE: a
    // price row being inserted for this plan holds a key-share lock on it,
    // which FOR UPDATE would deadlock against.
    await tx.$queryRaw`SELECT 1 FROM "plans" WHERE "id" = ${planId} FOR NO KEY UPDATE`;
    const previous = await tx.plan.findUniqueOrThrow({ where: { id: planId } });
    const { plan, change } = await settle(tx, await tx.plan.update({ where: { id: planId }, data }), price);
    if (onChange !== undefined) await onChange(tx, plan, change, previous);
    return plan;
  });
}

type MaybeLoaded = Plan & { defaultPrice?: PlanPrice | null };

/**
 * The same plans, each with its default price row. One read for the rows not
 * already loaded, and no write.
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
  return plans.map((plan) => ({
    ...plan,
    defaultPrice:
      plan.defaultPrice !== undefined
        ? plan.defaultPrice
        : plan.defaultPriceId === null
          ? null
          : (loaded.get(plan.defaultPriceId) ?? null),
  }));
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
  const plans = await prisma.plan.findMany({ where: { id: { in: ids } }, include: WITH_DEFAULT_PRICE });
  return new Map(plans.map((plan) => [plan.id, plan.defaultPrice]));
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
