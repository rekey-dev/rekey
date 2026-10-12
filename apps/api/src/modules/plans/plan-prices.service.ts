/**
 * A plan's prices in currencies other than its default one.
 *
 * The default price is written through the plan (`plansService`, which hands
 * it to `default-price.ts`). This service adds and removes the others, and
 * reads them all.
 */

import type { Plan, PlanPrice } from '@prisma/client';
import type { PlanPriceDto, PublicPlanPriceDto } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { recordBillingEvent } from '../billing-log/index.js';
import { retirePlanPrice, withDefaultPrice, type PlanWithDefaultPrice } from './default-price.js';
import { AMOUNT_EDITABLE_STATUSES, additionalPriceAmountLock, priceAmountEditable } from './price-amount-rule.js';
import { assertPriceAmount, priceCurrency } from './price-rules.js';
import { NO_PRICE_USAGE, priceUsageFor, type PriceUsage } from './price-usage.js';

const COUNTRY = /^[A-Za-z]{2}$/;
const MAX_COUNTRIES = 250;
/** Postgres `INTEGER`, which is what the column is. */

type PriceRow = Pick<
  PlanPrice,
  'id' | 'currency' | 'amount' | 'countries' | 'metadata' | 'registrationStatus' | 'registrationError'
>;

/**
 * The wire shape of one price, as the public catalogue shows it.
 *
 * @example
 * toPublicPlanPriceDto(row, plan);
 * // { id: 'pp_1', currency: 'INR', amount: 149900, countries: [], isDefault: false, archived: false }
 */
export function toPublicPlanPriceDto(
  price: Pick<PriceRow, 'id' | 'currency' | 'amount' | 'countries'>,
  plan: Pick<Plan, 'defaultPriceId'>,
): PublicPlanPriceDto {
  return {
    id: price.id,
    currency: price.currency,
    amount: price.amount,
    countries: [...price.countries].sort(),
    isDefault: price.id === plan.defaultPriceId,
    archived: false,
  };
}

/**
 * The wire shape of one price, as its operator reads it: where it stands at
 * the provider, whether its amount may still change, and who is on it.
 *
 * @example
 * toPlanPriceDto(row, plan, usage.get(row.id) ?? NO_PRICE_USAGE).registration; // { status: 'REGISTERED', error: null }
 */
export function toPlanPriceDto(price: PriceRow, plan: Pick<Plan, 'defaultPriceId' | 'metadata'>, usage: PriceUsage): PlanPriceDto {
  return {
    ...toPublicPlanPriceDto(price, plan),
    registration: { status: price.registrationStatus, error: price.registrationError },
    amountEditable: priceAmountEditable(price, plan, usage),
    liveSubscriptions: usage.liveSubscriptions,
    openCheckouts: usage.openCheckouts,
  };
}

/** One price as its operator reads it, with its usage read now. For a route that returns a single price. */
async function priceDto(price: PriceRow, plan: Pick<Plan, 'defaultPriceId' | 'metadata'>): Promise<PlanPriceDto> {
  return toPlanPriceDto(price, plan, (await priceUsageFor([price.id])).get(price.id) ?? NO_PRICE_USAGE);
}

function normaliseCountries(raw: readonly string[]): string[] {
  const bad = raw.find((country) => !COUNTRY.test(country));
  if (bad !== undefined || raw.length > MAX_COUNTRIES) {
    throw new RekeyError({
      statusCode: 400,
      code: 'PLAN_PRICE_COUNTRY_INVALID',
      message:
        bad !== undefined
          ? `"${bad}" is not an ISO 3166-1 alpha-2 country code.`
          : `A price can name at most ${MAX_COUNTRIES} countries.`,
      fix: 'Send two-letter country codes such as IN, DE or GB. Send an empty list to apply the price wherever its currency is the local one.',
    });
  }
  return [...new Set(raw.map((country) => country.toUpperCase()))].sort();
}

async function findPlan(applicationId: string, planRef: string): Promise<PlanWithDefaultPrice> {
  const plan =
    (await prisma.plan.findFirst({ where: { id: planRef, applicationId } })) ??
    (await prisma.plan.findUnique({ where: { applicationId_slug: { applicationId, slug: planRef } } }));
  if (plan) return withDefaultPrice(plan);
  throw new RekeyError({
    statusCode: 404,
    code: 'PLAN_NOT_FOUND',
    message: `Plan "${planRef}" not found in application "${applicationId}".`,
    fix: `Pass the plan's id or its slug. GET /api/v1/tenant/applications/${applicationId}/plans lists both.`,
  });
}

function immutable(plan: Plan, currency: string): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'PLAN_PRICE_IMMUTABLE',
    message: `The ${currency} price of plan "${plan.slug}" is registered with a payment provider, or is being registered, so its amount cannot be changed.`,
    fix: `A provider price object is immutable once created. \`countries\` can still be changed. To charge a different ${currency} amount, retire this plan (PATCH with {"active": false}) and create a replacement under a different slug with the new prices. The amount can only be edited on a price no checkout has used yet.`,
  });
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function referenced(applicationId: string, plan: Plan, currency: string, usage: PriceUsage): RekeyError {
  const url = `/api/v1/tenant/applications/${applicationId}/plans/${plan.slug}/prices/${currency}`;
  const holders = [
    usage.liveSubscriptions > 0 ? counted(usage.liveSubscriptions, 'live subscription') : null,
    usage.openCheckouts > 0 ? counted(usage.openCheckouts, 'open checkout') : null,
  ].filter((holder) => holder !== null);
  const replace = `DELETE ${url} takes this price off sale and keeps it archived, so every record that names it still says what was charged. Then PUT the new amount to the same URL: that is the plan's ${currency} price from then on.`;
  return new RekeyError({
    statusCode: 409,
    code: 'PLAN_PRICE_REFERENCED',
    message:
      holders.length > 0
        ? `The ${currency} price of plan "${plan.slug}" is used by ${holders.join(' and ')}, so its amount cannot be changed.`
        : `The ${currency} price of plan "${plan.slug}" is named by records of what buyers were charged (an ended subscription, a payment or a credit grant), so its amount cannot be changed.`,
    fix:
      holders.length > 0
        ? `A price keeps its amount while a record names it. \`countries\` can still be changed. Wait until those subscriptions have ended and the open checkouts have completed or expired (24 hours after they were opened). ${replace}`
        : `A price keeps its amount while a record names it. \`countries\` can still be changed. ${replace}`,
  });
}

type PriceValues = Pick<PlanPrice, 'id' | 'currency' | 'amount' | 'countries'>;

/**
 * The billing log's record of a price being set, with what it was before.
 * Written in the transaction that changes the price, so the two cannot
 * disagree. Nothing is recorded when the call changed nothing.
 */
export async function recordPriceSet(
  tx: Parameters<typeof recordBillingEvent>[0],
  plan: Pick<Plan, 'id' | 'applicationId' | 'slug' | 'defaultPriceId'>,
  before: PriceValues | null,
  after: PriceValues,
  actor: { operatorId: string } | undefined,
): Promise<void> {
  const values = (price: PriceValues) => ({ amount: price.amount, countries: [...price.countries].sort() });
  const unchanged = before !== null && JSON.stringify(values(before)) === JSON.stringify(values(after));
  if (unchanged) return;
  await recordBillingEvent(tx, {
    type: 'plan.price_set',
    applicationId: plan.applicationId,
    actor: actor === undefined ? { type: 'system' } : { type: 'operator', id: actor.operatorId },
    planId: plan.id,
    planPriceId: after.id,
    currency: after.currency,
    amount: after.amount,
    data: {
      planSlug: plan.slug,
      isDefault: after.id === plan.defaultPriceId,
      before: before === null ? null : values(before),
      after: values(after),
    },
  });
}

/**
 * Log that a price stopped being sold, in the transaction that retired it.
 *
 * @example
 * await recordPriceArchived(tx, plan, price, await retirePlanPrice(tx, price.id), { operatorId });
 */
export async function recordPriceArchived(
  tx: Parameters<typeof recordBillingEvent>[0],
  plan: Pick<Plan, 'id' | 'applicationId' | 'slug'>,
  price: Pick<PlanPrice, 'id' | 'currency' | 'amount'>,
  outcome: 'archived' | 'deleted',
  actor: { operatorId: string } | undefined,
): Promise<void> {
  await recordBillingEvent(tx, {
    type: 'plan.price_archived',
    applicationId: plan.applicationId,
    actor: actor === undefined ? { type: 'system' } : { type: 'operator', id: actor.operatorId },
    planId: plan.id,
    planPriceId: price.id,
    currency: price.currency,
    amount: price.amount,
    data: { planSlug: plan.slug, amount: price.amount, outcome },
  });
}

export const planPricesService = {
  /**
   * Every live price of the given plans, the default included, keyed by plan
   * id and sorted by currency. One query, whatever the number of plans.
   *
   * @example
   * const byPlan = await planPricesService.listForPlans(plans.map((p) => p.id));
   * const prices = byPlan.get(plan.id) ?? [];
   */
  async listForPlans(planIds: readonly string[]): Promise<Map<string, PlanPrice[]>> {
    const byPlan = new Map<string, PlanPrice[]>();
    if (planIds.length === 0) return byPlan;
    const rows = await prisma.planPrice.findMany({
      where: { planId: { in: [...planIds] }, archivedAt: null },
      orderBy: { currency: 'asc' },
    });
    for (const row of rows) byPlan.set(row.planId, [...(byPlan.get(row.planId) ?? []), row]);
    return byPlan;
  },

  /**
   * Create or update a plan's price in one more currency.
   *
   * `countries` may change at any time. `amount` may change only until a
   * provider has registered the price or a record names it.
   *
   * @example
   * await planPricesService.put({ applicationId, plan: 'pro', currency: 'inr', amount: 149900 });
   * // { currency: 'INR', amount: 149900, countries: [] }
   */
  async put(input: {
    applicationId: string;
    /** The plan's id or slug. */
    plan: string;
    currency: string;
    /** Required to create a price. Omitted, an existing price keeps its amount. */
    amount?: number | undefined;
    countries?: readonly string[] | undefined;
    /** The operator making the change, for the billing log. */
    actor?: { operatorId: string } | undefined;
  }): Promise<PlanPriceDto> {
    const currency = priceCurrency(input.currency);
    if (input.amount !== undefined) assertPriceAmount(currency, input.amount);
    const countries = input.countries === undefined ? undefined : normaliseCountries(input.countries);
    const plan = await findPlan(input.applicationId, input.plan);

    if (plan.kind === 'USAGE') {
      throw new RekeyError({
        statusCode: 400,
        code: 'PLAN_PRICE_NOT_APPLICABLE',
        message: `Plan "${plan.slug}" is a usage plan, which is sold at one price only, so it cannot be sold in ${currency} as well.`,
        fix: `Create a separate USAGE plan priced in ${currency}.`,
      });
    }
    if (plan.defaultPrice === null) {
      throw new RekeyError({
        statusCode: 400,
        code: 'PLAN_PRICE_NOT_APPLICABLE',
        message: `Plan "${plan.slug}" is free, so it has no price to offer in another currency.`,
        fix: 'Add prices in other currencies to a plan with a non-zero amount.',
      });
    }
    if (currency === plan.defaultPrice.currency) {
      throw new RekeyError({
        statusCode: 400,
        code: 'PLAN_PRICE_IS_DEFAULT',
        message: `${currency} is the currency of the default price of plan "${plan.slug}", which is not changed here.`,
        fix: `Change the default price with PATCH /api/v1/tenant/applications/${input.applicationId}/plans/${plan.slug} and a body such as {"price": {"currency": "${currency}", "amount": 1900}} (unregistered plans only). Additional prices are for other currencies.`,
      });
    }

    const where = { planId: plan.id, currency, archivedAt: null };
    const existing = await prisma.planPrice.findFirst({ where });
    if (existing === null && input.amount === undefined) {
      throw new RekeyError({
        statusCode: 400,
        code: 'PLAN_PRICE_AMOUNT_INVALID',
        message: `Plan "${plan.slug}" has no ${currency} price yet, so one cannot be created without an amount.`,
        fix: `Send \`amount\` as a positive integer in the smallest unit of ${currency}.`,
      });
    }
    const amount = input.amount ?? existing?.amount;
    if (existing === null && amount !== undefined) {
      try {
        const created = await prisma.$transaction(async (tx) => {
          const row = await tx.planPrice.create({
            data: {
              applicationId: input.applicationId,
              planId: plan.id,
              currency,
              amount,
              countries: countries ?? [],
            },
          });
          await recordPriceSet(tx, plan, null, row, input.actor);
          return row;
        });
        return priceDto(created, plan);
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
        // A concurrent PUT created it first; fall through and update that row.
      }
    }

    const current = existing ?? (await prisma.planPrice.findFirstOrThrow({ where }));
    const newAmount = input.amount !== undefined && input.amount !== current.amount ? input.amount : undefined;
    if (newAmount !== undefined) {
      const usage = (await priceUsageFor([current.id])).get(current.id) ?? NO_PRICE_USAGE;
      const lock = additionalPriceAmountLock(current, usage);
      if (lock === 'provider') throw immutable(plan, currency);
      if (lock === 'referenced') throw referenced(input.applicationId, plan, currency, usage);
    }
    const updated = await prisma.$transaction(async (tx) => {
      if (newAmount !== undefined) {
        // Conditional on the status as well: a checkout registering this price
        // right now has already read the old amount.
        const repriced = await tx.planPrice.updateMany({
          where: { id: current.id, registrationStatus: { in: [...AMOUNT_EDITABLE_STATUSES] } },
          data: { amount: newAmount },
        });
        if (repriced.count === 0) throw immutable(plan, currency);
      }
      const row = await tx.planPrice.update({
        where: { id: current.id },
        data: { ...(countries !== undefined && { countries }) },
      });
      await recordPriceSet(tx, plan, current, row, input.actor);
      return row;
    });
    return priceDto(updated, plan);
  },

  /**
   * Delete a plan's price in one currency, unless a buyer is on it.
   *
   * @example
   * await planPricesService.remove({ applicationId, plan: 'pro', currency: 'INR' });
   */
  async remove(input: {
    applicationId: string;
    plan: string;
    currency: string;
    actor?: { operatorId: string } | undefined;
  }): Promise<void> {
    const currency = input.currency.trim().toUpperCase();
    const plan = await findPlan(input.applicationId, input.plan);
    const price = await prisma.planPrice.findFirst({
      where: {
        planId: plan.id,
        currency,
        archivedAt: null,
        ...(plan.defaultPriceId !== null && { id: { not: plan.defaultPriceId } }),
      },
      select: { id: true, amount: true },
    });
    if (price === null) {
      throw new RekeyError({
        statusCode: 404,
        code: 'PLAN_PRICE_NOT_FOUND',
        message: `Plan "${plan.slug}" has no ${currency} price.`,
        fix: `GET /api/v1/tenant/applications/${input.applicationId}/plans lists each plan's \`prices\`.`,
      });
    }

    const { liveSubscriptions: subscriptions, openCheckouts: checkouts } =
      (await priceUsageFor([price.id])).get(price.id) ?? NO_PRICE_USAGE;
    if (subscriptions > 0 || checkouts > 0) {
      const holders = [
        subscriptions > 0 ? `${subscriptions} live subscription${subscriptions === 1 ? '' : 's'}` : null,
        checkouts > 0 ? `${checkouts} open checkout${checkouts === 1 ? '' : 's'}` : null,
      ].filter((holder) => holder !== null);
      throw new RekeyError({
        statusCode: 409,
        code: 'PLAN_PRICE_IN_USE',
        message: `The ${currency} price of plan "${plan.slug}" is used by ${holders.join(' and ')}.`,
        fix: 'A subscriber keeps their currency for the life of the subscription, so the price stays while they do. Delete it once those subscriptions have ended and the open checkouts have completed or expired (24 hours after they were opened).',
      });
    }
    // A price an ended subscription or a payment still names is kept, archived.
    await prisma.$transaction(async (tx) => {
      const outcome = await retirePlanPrice(tx, price.id);
      await recordPriceArchived(tx, plan, { id: price.id, currency, amount: price.amount }, outcome, input.actor);
    });
  },
};
