/**
 * Judges a charge a provider reports against what Rekey expected to be paid.
 *
 * A charge is applied only when it is in the currency of the price the
 * subscription is on, inside the amount band around that price, and for a
 * provider price that belongs to the subscription's plan. Anything else is
 * `not_applied`: the caller still records the money, as an UNVERIFIED payment
 * with an unapplied case, and grants nothing for it. No charge is dropped
 * here.
 */

import type { CheckoutSession, PlanPrice, Subscription } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { WITH_DEFAULT_PRICE, withDefaultPrice } from '../../plans/default-price.js';
import { providerRegistration } from '../priced-plan.js';
import { reportingCurrencyOf } from '../reporting-currency.js';
import { planPriceIn, pricedByCheckout, type SubscriptionPriceColumns } from '../unpriced-subscription.js';
import type { ApplyContext } from './apply-shared.js';

/**
 * How far above the price a single charge may land before it is treated as a
 * unit mismatch and not a sale: an amount in major units recorded as minor
 * units is a clean 100 times, which is why the bound is inclusive.
 */
const MAX_PRICE_MULTIPLE = 100;

/** How long after it was opened an unfinished checkout can still explain a charge in its currency. */
const UNFINISHED_CHECKOUT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export type NotAppliedReason = 'currency_mismatch' | 'amount_out_of_band' | 'price_not_on_plan';

/** A price as the billing log records it. */
export interface JudgedPrice {
  planPriceId: string | null;
  currency: string;
  amount: number;
}

export type ChargeVerdict =
  | {
      kind: 'apply';
      /** Upper-case. The charge's own, or the expected price's when the charge named none. */
      currency: string;
      /** The price the charge was held to. Null for a plan with no flat price. */
      price: JudgedPrice | null;
      /** A price this payment gives a subscription that had none, or had only an assumed one. Written with the payment. */
      firstPrice: SubscriptionPriceColumns | null;
      /** The coupon discount the charge already carries, when it pays for a checkout that had one. */
      discountAmount: number;
      /** The CheckoutSession row the charge pays for, when it names one. */
      checkoutSessionId: string | null;
    }
  | {
      kind: 'not_applied';
      reason: NotAppliedReason;
      currency: string;
      expected: JudgedPrice | null;
      /** One sentence for the webhook receipt. */
      note: string;
    };

export interface JudgedCharge {
  amount: number;
  currency: string | null | undefined;
  providerPaymentId: string;
  /** The provider's id for the price billed, when the event names exactly one. */
  providerPriceId?: string | undefined;
  /** The provider session or order the charge pays, when the event names it. */
  providerSessionId?: string | undefined;
}

type ChargedSubscription = Pick<
  Subscription,
  'id' | 'applicationId' | 'planId' | 'planPriceId' | 'currency' | 'unitAmount' | 'metadata' | 'provider'
>;

type SessionPrice = Pick<
  CheckoutSession,
  'id' | 'kind' | 'status' | 'currency' | 'unitAmount' | 'planPriceId' | 'chargeAmount' | 'discountAmount' | 'createdAt'
>;

async function sessionNamedBy(subscription: ChargedSubscription, providerSessionId: string | undefined): Promise<SessionPrice | null> {
  if (providerSessionId === undefined || providerSessionId === '') return null;
  return prisma.checkoutSession.findFirst({
    where: { applicationId: subscription.applicationId, subscriptionId: subscription.id, providerSessionId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * A checkout of this subscription the buyer could be paying right now in
 * `currency`. An expired one still counts for a short while, since a payment
 * approved just before expiry arrives after it; an abandoned checkout from
 * last month does not.
 */
async function unfinishedSessionIn(subscription: ChargedSubscription, currency: string): Promise<SessionPrice | null> {
  return prisma.checkoutSession.findFirst({
    where: {
      subscriptionId: subscription.id,
      status: { in: ['OPEN', 'CONFIRMING', 'EXPIRED'] },
      createdAt: { gte: new Date(Date.now() - UNFINISHED_CHECKOUT_WINDOW_MS) },
      unitAmount: { not: null },
      currency: { equals: currency, mode: 'insensitive' },
    },
    orderBy: { createdAt: 'desc' },
  });
}

function priceOfSession(session: SessionPrice): JudgedPrice | null {
  if (session.currency === null || session.unitAmount === null) return null;
  return { planPriceId: session.planPriceId, currency: session.currency.toUpperCase(), amount: session.unitAmount };
}

function ownPrice(subscription: ChargedSubscription): JudgedPrice | null {
  if (subscription.currency === null || subscription.unitAmount === null) return null;
  return { planPriceId: subscription.planPriceId, currency: subscription.currency.toUpperCase(), amount: subscription.unitAmount };
}

/**
 * Whether the subscription's price is a fact about what its subscriber pays:
 * a checkout fixed it, or a verified payment has been taken at it. A price an
 * activation or an import assumed, with no payment yet, is not.
 *
 * @example
 * if (!(await priceIsSettled(subscription))) await replacePrice(subscription.id, named, tx);
 */
export async function priceIsSettled(subscription: ChargedSubscription): Promise<boolean> {
  if (await pricedByCheckout(subscription)) return true;
  const paid = await prisma.payment.findFirst({
    where: { subscriptionId: subscription.id, status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, verification: 'VERIFIED' },
    select: { id: true },
  });
  return paid !== null;
}

function asColumns(price: JudgedPrice): SubscriptionPriceColumns | null {
  return price.planPriceId === null ? null : { planPriceId: price.planPriceId, currency: price.currency, unitAmount: price.amount };
}

/** The provider's id registered for a price row with this provider, if any. */
function registeredId(price: Pick<PlanPrice, 'metadata'>, provider: string): string | undefined {
  const registration = providerRegistration({ registration: price.metadata }, provider);
  return registration.priceId ?? registration.planId;
}

/**
 * The price row of this plan a provider price id belongs to, beside the id
 * registered for the price the subscription is on. `'unregistered'` when that
 * price was never registered with this provider, so there is nothing to
 * compare; `billed: null` when the id belongs to no price of the plan.
 */
async function priceRowBilled(
  planId: string,
  applicationId: string,
  expectedPriceId: string | null,
  provider: string,
  providerPriceId: string,
): Promise<'unregistered' | { registered: string; billed: PlanPrice | null }> {
  const rows = await prisma.planPrice.findMany({ where: { planId, applicationId } });
  const expected = rows.find((row) => row.id === expectedPriceId);
  const registered = expected === undefined ? undefined : registeredId(expected, provider);
  if (registered === undefined) return 'unregistered';
  return { registered, billed: rows.find((row) => registeredId(row, provider) === providerPriceId) ?? null };
}

/**
 * Judge one charge against the subscription it names.
 *
 * @example
 * const verdict = await judgeCharge(sub, { amount: 149900, currency: 'INR', providerPaymentId: 'pay_1' }, ctx);
 * if (verdict.kind === 'not_applied') { … record UNVERIFIED, open a case … }
 */
export async function judgeCharge(
  subscription: ChargedSubscription,
  charge: JudgedCharge,
  ctx: Pick<ApplyContext, 'log' | 'provider'>,
): Promise<ChargeVerdict> {
  const plan = await prisma.plan
    .findUnique({ where: { id: subscription.planId }, include: WITH_DEFAULT_PRICE })
    .then((row) => (row === null ? null : withDefaultPrice(row)));
  const named = charge.currency ? charge.currency.toUpperCase() : null;
  const session = await sessionNamedBy(subscription, charge.providerSessionId);
  // A recurring session that already completed has handed its price to the
  // subscription, and every renewal names it again. A one-time session is
  // paid once, so its charge is held to it whenever it arrives.
  const payingSession = session !== null && (session.status !== 'COMPLETE' || session.kind === 'ONE_TIME') ? session : null;

  let expected = ownPrice(subscription);
  let firstPrice: SubscriptionPriceColumns | null = null;
  let viaSession: SessionPrice | null = null;

  if (payingSession !== null && priceOfSession(payingSession) !== null) {
    // The charge pays a checkout Rekey priced: that checkout's price is what
    // it is held to, whatever the row held before.
    expected = priceOfSession(payingSession);
    viaSession = payingSession;
  } else if (named !== null && (expected === null || expected.currency !== named)) {
    const unfinished = await unfinishedSessionIn(subscription, named);
    const fromUnfinished = unfinished === null ? null : priceOfSession(unfinished);
    if (fromUnfinished !== null) {
      expected = fromUnfinished;
      viaSession = unfinished;
    } else if (plan !== null && !(await priceIsSettled(subscription))) {
      // No checkout and no payment yet: the first charge says what this
      // subscriber pays, when the plan sells at a price in its currency.
      const { price } = await planPriceIn(plan, named);
      if (price !== null) {
        expected = { planPriceId: price.planPriceId, currency: price.currency.toUpperCase(), amount: price.unitAmount };
        firstPrice = price;
      }
    }
  }

  if (expected === null) {
    // A plan with no flat price has nothing to hold a charge against. A
    // charge that names no currency there is in the one the Application reports in.
    const fallback = plan?.defaultPrice ?? null;
    if (fallback === null) {
      const currency = named ?? (await reportingCurrencyOf(subscription.applicationId)).toUpperCase();
      return { kind: 'apply', currency, price: null, firstPrice: null, discountAmount: 0, checkoutSessionId: null };
    }
    // An unpriced row on a priced plan is on the plan's default price.
    expected = { planPriceId: fallback.id, currency: fallback.currency.toUpperCase(), amount: fallback.amount };
    if (!(await pricedByCheckout(subscription))) firstPrice = asColumns(expected);
  }

  const currency = named ?? expected.currency;
  const context = { providerPaymentId: charge.providerPaymentId, subscriptionId: subscription.id, planSlug: plan?.slug };
  if (currency !== expected.currency) {
    ctx.log.error({ ...context, currency, expectedCurrency: expected.currency }, 'webhook charge is not in the currency of the price this subscription is on; recorded unverified, not applied');
    return {
      kind: 'not_applied',
      reason: 'currency_mismatch',
      currency,
      expected,
      note:
        `Payment "${charge.providerPaymentId}" is in ${currency}, but the subscription it names is priced in ${expected.currency}` +
        `${plan ? ` on plan "${plan.slug}"` : ''}. It was recorded as unverified and nothing was granted for it.`,
    };
  }

  const exact = viaSession !== null && viaSession.kind === 'ONE_TIME' && viaSession.chargeAmount !== null ? viaSession.chargeAmount : null;
  if (exact !== null && charge.amount !== exact) {
    ctx.log.error({ ...context, amount: charge.amount, expectedAmount: exact }, 'webhook charge is not the amount its one-time checkout was opened at; recorded unverified, not applied');
    return {
      kind: 'not_applied',
      reason: 'amount_out_of_band',
      currency,
      expected,
      note:
        `Payment "${charge.providerPaymentId}" is ${charge.amount} ${currency} (smallest unit), and the checkout it pays was opened at ` +
        `${exact}. It was recorded as unverified and nothing was granted for it.`,
    };
  }
  // The larger of the two prices: a plan repriced upward is bought again at
  // the new price before the subscription row has taken it. A usage plan
  // bills on consumption, so it has no ceiling.
  const ceilingBase = Math.max(expected.amount, plan?.defaultPrice?.amount ?? 0);
  if (plan?.kind !== 'USAGE' && ceilingBase > 0 && charge.amount >= ceilingBase * MAX_PRICE_MULTIPLE) {
    ctx.log.error({ ...context, amount: charge.amount, priceAmount: ceilingBase }, 'webhook charge is 100 times its price or more; recorded unverified, not applied. Probable unit mismatch.');
    return {
      kind: 'not_applied',
      reason: 'amount_out_of_band',
      currency,
      expected,
      note:
        `Payment "${charge.providerPaymentId}" is ${charge.amount} ${currency} (smallest unit), ${MAX_PRICE_MULTIPLE} times the price ` +
        `(${ceilingBase}) or more, which reads as major units sent as minor units. It was recorded as unverified and nothing was granted for it.`,
    };
  }

  const provider = ctx.provider ?? subscription.provider;
  if (charge.providerPriceId !== undefined && provider) {
    const compared = await priceRowBilled(subscription.planId, subscription.applicationId, expected.planPriceId, provider, charge.providerPriceId);
    const billed = compared === 'unregistered' ? 'unregistered' : compared.billed;
    if (compared !== 'unregistered' && billed === null) {
      ctx.log.error({ ...context, provider, providerPriceId: charge.providerPriceId }, 'webhook charge bills a provider price that belongs to no price of this plan; recorded unverified, not applied');
      return {
        kind: 'not_applied',
        reason: 'price_not_on_plan',
        currency,
        expected,
        note:
          `Payment "${charge.providerPaymentId}" bills ${provider} price "${charge.providerPriceId}", which is not registered for any price of ` +
          `${plan ? `plan "${plan.slug}"` : 'the plan'}; the subscription it names is on "${compared.registered}". ` +
          `It was recorded as unverified and nothing was granted for it; check the price at ${provider}.`,
      };
    }
    if (billed !== 'unregistered' && billed !== null && billed.currency.toUpperCase() !== currency) {
      ctx.log.error({ ...context, provider, providerPriceId: charge.providerPriceId, billedCurrency: billed.currency }, 'webhook charge bills a provider price registered in another currency than it was charged in; recorded unverified, not applied');
      return {
        kind: 'not_applied',
        reason: 'price_not_on_plan',
        currency,
        expected,
        note:
          `Payment "${charge.providerPaymentId}" bills ${provider} price "${charge.providerPriceId}", which Rekey holds as a ${billed.currency.toUpperCase()} price, ` +
          `but the charge is in ${currency}. It was recorded as unverified and nothing was granted for it; check the price at ${provider}.`,
      };
    }
    if (billed !== 'unregistered' && billed !== null && billed.id !== expected.planPriceId) {
      // Another price of the same plan and currency (an archived one, say).
      // The payment records the price that was billed.
      ctx.log.warn({ ...context, provider, providerPriceId: charge.providerPriceId, billedPlanPriceId: billed.id }, 'webhook charge bills another price of the same plan than the one this subscription is on');
      expected = { planPriceId: billed.id, currency: billed.currency.toUpperCase(), amount: billed.amount };
      firstPrice = null;
    }
  }

  return {
    kind: 'apply',
    currency,
    price: expected,
    firstPrice,
    discountAmount: viaSession?.discountAmount ?? 0,
    checkoutSessionId: session?.id ?? null,
  };
}
