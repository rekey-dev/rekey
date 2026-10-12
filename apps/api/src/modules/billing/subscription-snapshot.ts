/**
 * The one place a subscription's price is written.
 *
 * A subscription holds a snapshot of what it pays: `planPriceId`, `currency`
 * and `unitAmount`, all three or none. No database constraint holds that:
 * it is true because nothing else assigns those columns, and
 * `test/money-source-scan.test.ts` type-checks the source tree to keep it so.
 */

import type { Plan, PlanPrice, Prisma } from '@prisma/client';
import { RekeyError } from '../../lib/error.js';
import { withDefaultPrice } from '../plans/default-price.js';
import { logSubscriptionPriced, type Origin } from './money-events.js';

type Db = Prisma.TransactionClient;

export interface SubscriptionPriceSnapshot {
  planPriceId: string;
  currency: string;
  unitAmount: number;
}

export interface SnapshotSubscriptionPriceInput {
  subscriptionId: string;
  /**
   * The Application the caller is acting for. A subscription of any other
   * Application is left alone, whatever id was passed.
   */
  applicationId?: string | undefined;
  /** The price row, or `'default'` for the plan's default price. */
  planPriceId: string | 'default';
  /**
   * What the subscriber actually pays when it is not the price's own amount: a
   * negotiated grant, or the amount a checkout was opened at before the price
   * was edited.
   */
  unitAmountOverride?: number | undefined;
  /**
   * With `'default'`: the currency the money was taken in, when the caller
   * knows it. If the plan's default price has since moved to another
   * currency, the snapshot names an archived price in the charged one instead
   * of relabelling the payment.
   */
  chargedCurrency?: string | undefined;
  /**
   * Write only when the subscription has no price yet. The condition is part
   * of the update, so a checkout completing at the same moment keeps the
   * buyer's real price.
   */
  onlyIfUnpriced?: boolean | undefined;
  /**
   * Who priced it and why, for the billing log. With it, a write that changes
   * the price records `subscription.priced` in the same transaction.
   */
  logged?: (Origin & { cause: 'checkout' | 'first_payment' | 'grant' | 'import' | 'provider'; checkoutSessionId?: string | undefined }) | undefined;
}

export interface SnapshotSubscriptionPriceResult {
  written: boolean;
  /** What was written, or null when nothing was. */
  price: SubscriptionPriceSnapshot | null;
}

const NOTHING_WRITTEN: SnapshotSubscriptionPriceResult = { written: false, price: null };

function inTransaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  // A root client is accepted wherever a transaction client is. The snapshot
  // is several statements, so it opens its own transaction around them.
  const root = db as Db & { $transaction?: (fn: (tx: Db) => Promise<T>) => Promise<T> };
  return typeof root.$transaction === 'function' ? root.$transaction(work) : work(db);
}

/** A price row for money already taken in a currency the plan no longer sells. */
async function archivedPriceFor(db: Db, plan: Plan, currency: string, amount: number): Promise<PlanPrice | null> {
  if (amount <= 0) return null;
  const known = await db.planPrice.findFirst({
    where: { planId: plan.id, currency },
    orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
  });
  if (known !== null) return known;
  return db.planPrice.create({
    data: { applicationId: plan.applicationId, planId: plan.id, currency, amount, archivedAt: new Date() },
  });
}

async function resolvePrice(
  db: Db,
  plan: Plan,
  input: SnapshotSubscriptionPriceInput,
): Promise<PlanPrice | null> {
  if (input.planPriceId !== 'default') {
    const price = await db.planPrice.findFirst({ where: { id: input.planPriceId, planId: plan.id } });
    if (price === null) {
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_PLAN_PRICE_NOT_FOUND',
        message: `Plan "${plan.slug}" has no price with id ${input.planPriceId}.`,
        fix: `Read the plan's \`prices\` with GET /api/v1/tenant/applications/${plan.applicationId}/plans and name one of them, or pass no currency to use the plan's default price.`,
      });
    }
    return price;
  }

  const { defaultPrice } = await withDefaultPrice(plan, db);
  const charged = input.chargedCurrency?.toUpperCase();
  if (charged !== undefined && charged !== defaultPrice?.currency) {
    return archivedPriceFor(db, plan, charged, input.unitAmountOverride ?? 0);
  }
  return defaultPrice;
}

/**
 * Write the price a subscription pays, from one of its plan's price rows.
 *
 * Returns `written: false` when there was nothing to write: the plan charges
 * no flat amount, so it has no price row, or `onlyIfUnpriced` was set and the
 * subscription already had a price.
 *
 * @example
 * await prisma.$transaction(async (tx) => {
 *   await snapshotSubscriptionPrice(tx, { subscriptionId: sub.id, planPriceId: 'default' });
 * });
 *
 * @example
 * // A grant at a negotiated amount, in the plan's INR price.
 * await snapshotSubscriptionPrice(tx, { subscriptionId: sub.id, planPriceId: inr.id, unitAmountOverride: 99900 });
 */
export async function snapshotSubscriptionPrice(
  tx: Db,
  input: SnapshotSubscriptionPriceInput,
): Promise<SnapshotSubscriptionPriceResult> {
  const override = input.unitAmountOverride;
  if (override !== undefined && (!Number.isSafeInteger(override) || override < 0)) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_UNIT_AMOUNT_INVALID',
      message: `A subscription's amount is a whole number of the currency's smallest unit, 0 or more, not ${override}.`,
      fix: 'Send the amount in minor units (paise, cents, pence), never as a decimal.',
    });
  }

  return inTransaction(tx, async (db) => {
    const subscription = await db.subscription.findFirst({
      where: { id: input.subscriptionId, ...(input.applicationId !== undefined && { applicationId: input.applicationId }) },
      select: { id: true, endUserId: true, planPriceId: true, currency: true, unitAmount: true, plan: true },
    });
    if (subscription === null) return NOTHING_WRITTEN;

    const row = await resolvePrice(db, subscription.plan, input);
    if (row === null) return NOTHING_WRITTEN;

    // The currency is the price row's, always: the row is what the amount is
    // an amount of.
    const price: SubscriptionPriceSnapshot = {
      planPriceId: row.id,
      currency: row.currency,
      unitAmount: override ?? row.amount,
    };
    const { count } = await db.subscription.updateMany({
      where: { id: subscription.id, ...(input.onlyIfUnpriced === true && { currency: null }) },
      data: price,
    });
    if (count !== 1) return NOTHING_WRITTEN;
    const before =
      subscription.currency === null || subscription.unitAmount === null
        ? null
        : { planPriceId: subscription.planPriceId, currency: subscription.currency, amount: subscription.unitAmount };
    const changed = before === null || before.planPriceId !== price.planPriceId || before.amount !== price.unitAmount;
    if (input.logged !== undefined && changed) {
      await logSubscriptionPriced(
        db,
        {
          id: subscription.id,
          applicationId: subscription.plan.applicationId,
          endUserId: subscription.endUserId,
          planId: subscription.plan.id,
          planSlug: subscription.plan.slug,
        },
        { before, after: { planPriceId: price.planPriceId, currency: price.currency, amount: price.unitAmount } },
        input.logged,
      );
    }
    return { written: true, price };
  });
}
