/**
 * The billing log's records of what checkout, the webhook appliers, grants
 * and imports do to money: one function per fact, each written in the
 * transaction of the change it describes.
 *
 * Every write goes through `recordMoneyPathBillingEvent`: by the time one of
 * these runs a provider has moved money or a subscriber has been given
 * access, and an event its schema refuses must never undo that.
 */

import type { Prisma } from '@prisma/client';
import { recordMoneyPathBillingEvent, type BillingEventInput, type BillingLogLogger } from '../billing-log/index.js';

type Db = Prisma.TransactionClient;

/** Who did it. A provider is named by its registry name, a person by id. */
export type MoneyActor =
  | { type: 'provider'; id?: string | undefined }
  | { type: 'operator'; id?: string | undefined }
  | { type: 'end_user'; id: string }
  /** Rekey itself, or the Application's own server holding a secret key: then `id` is the key's id. */
  | { type: 'system'; id?: string | undefined };

function actorOf(actor: MoneyActor): BillingEventInput['actor'] {
  return actor.id === undefined ? { type: actor.type } : { type: actor.type, id: actor.id.slice(0, 255) };
}

/** A price as the log records it: the row, its currency upper-case, its amount. */
export interface LoggedPrice {
  planPriceId: string | null;
  currency: string;
  amount: number;
}

function loggedPrice(price: LoggedPrice | null): LoggedPrice | null {
  if (price === null || !/^[A-Za-z]{3}$/.test(price.currency)) return null;
  return { planPriceId: price.planPriceId, currency: price.currency.toUpperCase(), amount: Math.max(0, price.amount) };
}

function currencyField(currency: string | null | undefined): { currency?: string } {
  return currency != null && /^[A-Za-z]{3}$/.test(currency) ? { currency: currency.toUpperCase() } : {};
}

/** The ids and money an event's envelope carries beside its `data`. */
interface Envelope {
  endUserId?: string;
  subscriptionId?: string;
  checkoutSessionId?: string;
  paymentId?: string;
  planId?: string;
  planPriceId?: string;
  currency?: string;
  amount?: number;
}

export interface Origin {
  actor: MoneyActor;
  provider?: string | null | undefined;
  providerEventId?: string | undefined;
  log?: BillingLogLogger | undefined;
}

function originFields(origin: Origin): { actor: BillingEventInput['actor']; provider?: string; providerEventId?: string } {
  return {
    actor: actorOf(origin.actor),
    ...(origin.provider != null && /^[A-Za-z0-9_.:-]{1,120}$/.test(origin.provider) && { provider: origin.provider }),
    ...(origin.providerEventId !== undefined && origin.providerEventId !== '' && { providerEventId: origin.providerEventId.slice(0, 255) }),
  };
}

export interface LoggedPayment {
  id: string;
  applicationId: string;
  endUserId: string | null;
  subscriptionId: string | null;
  planPriceId: string | null;
  unitAmount: number | null;
  discountAmount: number;
  amount: number;
  currency: string;
  providerPaymentId: string | null;
  verification: 'VERIFIED' | 'UNVERIFIED';
}

function paymentFields(payment: LoggedPayment): Envelope {
  return {
    paymentId: payment.id,
    ...(payment.endUserId !== null && { endUserId: payment.endUserId }),
    ...(payment.subscriptionId !== null && { subscriptionId: payment.subscriptionId }),
    ...(payment.planPriceId !== null && { planPriceId: payment.planPriceId }),
    ...currencyField(payment.currency),
    amount: payment.amount,
  };
}

/**
 * A payment row was written as collected.
 *
 * @example
 * await logPaymentRecorded(tx, payment, { actor: { type: 'provider', id: 'stripe' }, provider: 'stripe', providerEventId: ev.providerEventId });
 */
export async function logPaymentRecorded(tx: Db, payment: LoggedPayment, origin: Origin): Promise<void> {
  await recordMoneyPathBillingEvent(
    tx,
    {
      type: 'payment.recorded',
      applicationId: payment.applicationId,
      ...originFields(origin),
      ...paymentFields(payment),
      data: {
        priceCharged:
          payment.planPriceId !== null && payment.unitAmount !== null
            ? loggedPrice({ planPriceId: payment.planPriceId, currency: payment.currency, amount: payment.unitAmount })
            : null,
        discountAmount: payment.discountAmount,
        providerPaymentId: payment.providerPaymentId,
        verification: payment.verification === 'VERIFIED' ? 'verified' : 'unverified',
      },
    },
    origin.log,
  );
}

/**
 * A charge was recorded and nothing was granted for it, and why.
 *
 * @example
 * await logPaymentNotApplied(tx, payment, { reason: 'currency_mismatch', expected, subscriptionId: sub.id }, origin);
 */
export async function logPaymentNotApplied(
  tx: Db,
  payment: LoggedPayment,
  why: {
    reason: 'currency_mismatch' | 'amount_out_of_band' | 'price_not_on_plan' | 'no_subscription' | 'duplicate_completion';
    expected: LoggedPrice | null;
    /** The subscription the charge named, which the payment is not linked to. */
    subscriptionId?: string | undefined;
  },
  origin: Origin,
): Promise<void> {
  await recordMoneyPathBillingEvent(
    tx,
    {
      type: 'payment.not_applied',
      applicationId: payment.applicationId,
      ...originFields(origin),
      ...paymentFields(payment),
      ...(why.subscriptionId !== undefined && { subscriptionId: why.subscriptionId }),
      data: { reason: why.reason, expected: loggedPrice(why.expected), providerPaymentId: payment.providerPaymentId },
    },
    origin.log,
  );
}

/**
 * A payment row was written as failed.
 *
 * @example
 * await logPaymentFailed(tx, payment, origin);
 */
export async function logPaymentFailed(tx: Db, payment: LoggedPayment, origin: Origin): Promise<void> {
  await recordMoneyPathBillingEvent(
    tx,
    {
      type: 'payment.failed',
      applicationId: payment.applicationId,
      ...originFields(origin),
      ...paymentFields(payment),
      data: { providerPaymentId: payment.providerPaymentId, failureCode: null },
    },
    origin.log,
  );
}

async function subscriptionForLog(tx: Db, subscriptionId: string) {
  return tx.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      id: true,
      applicationId: true,
      endUserId: true,
      planId: true,
      planPriceId: true,
      currency: true,
      unitAmount: true,
      status: true,
      provider: true,
      plan: { select: { slug: true } },
    },
  });
}

type LoggedSubscription = NonNullable<Awaited<ReturnType<typeof subscriptionForLog>>>;

function priceOf(sub: LoggedSubscription): LoggedPrice | null {
  if (sub.currency === null || sub.unitAmount === null) return null;
  return loggedPrice({ planPriceId: sub.planPriceId, currency: sub.currency, amount: sub.unitAmount });
}

function subscriptionFields(sub: LoggedSubscription): Envelope {
  const price = priceOf(sub);
  return {
    endUserId: sub.endUserId,
    subscriptionId: sub.id,
    planId: sub.planId,
    ...(sub.planPriceId !== null && { planPriceId: sub.planPriceId }),
    ...(price !== null && { currency: price.currency, amount: price.amount }),
  };
}

/**
 * A subscription became entitling. Read through `tx`, so it reports the row
 * as the caller's transaction leaves it: call it after the status and the
 * price are written.
 *
 * @example
 * await logSubscriptionActivated(tx, sub.id, { via: 'checkout', trial: false }, origin);
 */
export async function logSubscriptionActivated(
  tx: Db,
  subscriptionId: string,
  how: { via: 'checkout' | 'grant' | 'import' | 'provider'; trial: boolean; checkoutSessionId?: string | undefined },
  origin: Origin,
): Promise<void> {
  const sub = await subscriptionForLog(tx, subscriptionId);
  if (sub === null) return;
  await recordMoneyPathBillingEvent(
    tx,
    {
      type: 'subscription.activated',
      applicationId: sub.applicationId,
      ...originFields({ ...origin, provider: origin.provider ?? sub.provider }),
      ...subscriptionFields(sub),
      ...(how.checkoutSessionId !== undefined && { checkoutSessionId: how.checkoutSessionId }),
      data: { planSlug: sub.plan.slug, price: priceOf(sub), via: how.via, trial: how.trial },
    },
    origin.log,
  );
}

/**
 * A subscription was canceled, now or at the end of its period.
 *
 * @example
 * await logSubscriptionCanceled(tx, sub.id, { atPeriodEnd: true, cause: 'end_user' }, { actor: { type: 'end_user', id: endUser.id } });
 */
export async function logSubscriptionCanceled(
  tx: Db,
  subscriptionId: string,
  how: { atPeriodEnd: boolean; cause: 'operator' | 'end_user' | 'provider' | 'dunning' | 'system' },
  origin: Origin,
): Promise<void> {
  const sub = await subscriptionForLog(tx, subscriptionId);
  if (sub === null) return;
  await recordMoneyPathBillingEvent(
    tx,
    {
      type: 'subscription.canceled',
      applicationId: sub.applicationId,
      ...originFields({ ...origin, provider: origin.provider ?? sub.provider }),
      ...subscriptionFields(sub),
      data: { planSlug: sub.plan.slug, atPeriodEnd: how.atPeriodEnd, cause: how.cause },
    },
    origin.log,
  );
}

/**
 * An operator, or a system acting for one, granted a subscription.
 *
 * @example
 * await logSubscriptionGranted(tx, sub.id, { actor: { type: 'operator', id: operatorId } });
 */
export async function logSubscriptionGranted(tx: Db, subscriptionId: string, origin: Origin): Promise<void> {
  const sub = await subscriptionForLog(tx, subscriptionId);
  if (sub === null) return;
  await recordMoneyPathBillingEvent(
    tx,
    {
      type: 'subscription.granted',
      applicationId: sub.applicationId,
      ...originFields(origin),
      ...subscriptionFields(sub),
      data: { planSlug: sub.plan.slug, price: priceOf(sub) },
    },
    origin.log,
  );
}

/**
 * A subscription was created or updated by an import.
 *
 * @example
 * await logSubscriptionImported(tx, sub.id, null, { actor: { type: 'operator', id: operatorId } });
 */
export async function logSubscriptionImported(
  tx: Db,
  subscriptionId: string,
  importRunId: string | null,
  origin: Origin,
): Promise<void> {
  const sub = await subscriptionForLog(tx, subscriptionId);
  if (sub === null) return;
  await recordMoneyPathBillingEvent(
    tx,
    {
      type: 'subscription.imported',
      applicationId: sub.applicationId,
      ...originFields(origin),
      ...subscriptionFields(sub),
      data: { planSlug: sub.plan.slug, price: priceOf(sub), importRunId },
    },
    origin.log,
  );
}

/**
 * A checkout was paid: the session, the price it charged and its discount.
 *
 * @example
 * await logCheckoutCompleted(tx, session, 'pro', origin);
 */
export async function logCheckoutCompleted(
  tx: Db,
  session: {
    id: string;
    applicationId: string;
    endUserId: string;
    subscriptionId: string;
    provider: string;
    providerSessionId: string;
    planPriceId: string | null;
    currency: string | null;
    unitAmount: number | null;
    discountAmount: number | null;
    chargeAmount: number | null;
  },
  plan: { id: string; slug: string },
  origin: Origin,
): Promise<void> {
  const price =
    session.currency === null || session.unitAmount === null
      ? null
      : loggedPrice({ planPriceId: session.planPriceId, currency: session.currency, amount: session.unitAmount });
  // A session with no price is one opened for a plan with no flat price,
  // which the event's shape has no way to state.
  if (price === null) return;
  await recordMoneyPathBillingEvent(
    tx,
    {
      type: 'checkout.completed',
      applicationId: session.applicationId,
      // One completion per session, whichever provider event reported it.
      dedupeKey: `checkout.completed:${session.id}`,
      ...originFields({ ...origin, provider: origin.provider ?? session.provider }),
      endUserId: session.endUserId,
      subscriptionId: session.subscriptionId,
      checkoutSessionId: session.id,
      planId: plan.id,
      ...(session.planPriceId !== null && { planPriceId: session.planPriceId }),
      currency: price.currency,
      amount: session.chargeAmount ?? price.amount,
      data: {
        planSlug: plan.slug,
        priceCharged: price,
        discountAmount: session.discountAmount ?? 0,
        providerSessionId: session.providerSessionId.slice(0, 255),
      },
    },
    origin.log,
  );
}

/**
 * Credits were added to a balance: bought, refilled by a renewal, or granted
 * by an operator. Called from inside the ledger write, so the event exists
 * exactly when the entry does.
 *
 * @example
 * await logCreditsGranted(tx, entry, { source: 'purchase', subscriptionId: sub.id, planId: plan.id, ownerEndUserId: sub.endUserId });
 */
export async function logCreditsGranted(
  tx: Db,
  entry: {
    id: string;
    applicationId: string;
    endUserId: string | null;
    delta: number;
    balanceAfter: number;
    paymentId: string | null;
    planPriceId: string | null;
  },
  how: {
    source: 'purchase' | 'refill' | 'operator' | 'api_key' | 'plan';
    subscriptionId?: string | undefined;
    planId?: string | undefined;
    /** The buyer, when the credits went to an organization's balance. */
    ownerEndUserId?: string | undefined;
    provider?: string | null | undefined;
    actor?: MoneyActor | undefined;
    log?: BillingLogLogger | undefined;
  },
): Promise<void> {
  const endUserId = entry.endUserId ?? how.ownerEndUserId;
  await recordMoneyPathBillingEvent(
    tx,
    {
      type: 'credits.granted',
      applicationId: entry.applicationId,
      // One event per ledger entry.
      dedupeKey: `credits.granted:${entry.id}`,
      ...originFields({ actor: how.actor ?? { type: 'system' }, provider: how.provider }),
      ...(endUserId !== undefined && endUserId !== null && { endUserId }),
      ...(how.subscriptionId !== undefined && { subscriptionId: how.subscriptionId }),
      ...(entry.paymentId !== null && { paymentId: entry.paymentId }),
      ...(how.planId !== undefined && { planId: how.planId }),
      ...(entry.planPriceId !== null && { planPriceId: entry.planPriceId }),
      data: { credits: entry.delta, source: how.source, balanceAfter: entry.balanceAfter },
    },
    how.log,
  );
}

/**
 * A subscription took a price, or moved from one to another: at checkout
 * completion, on a first payment, by a grant or an import. Written by
 * `snapshotSubscriptionPrice`, the one place a subscription's price changes.
 *
 * @example
 * await logSubscriptionPriced(tx, sub, { before: null, after: { planPriceId: 'pp_1', currency: 'INR', amount: 149900 } }, { cause: 'checkout', actor: { type: 'provider', id: 'razorpay' } });
 */
export async function logSubscriptionPriced(
  tx: Db,
  sub: { id: string; applicationId: string; endUserId: string; planId: string; planSlug: string },
  change: { before: LoggedPrice | null; after: LoggedPrice },
  origin: Origin & { cause: 'checkout' | 'first_payment' | 'grant' | 'import' | 'provider'; checkoutSessionId?: string | undefined },
): Promise<void> {
  const after = loggedPrice(change.after);
  if (after === null) return;
  await recordMoneyPathBillingEvent(
    tx,
    {
      type: 'subscription.priced',
      applicationId: sub.applicationId,
      ...originFields(origin),
      endUserId: sub.endUserId,
      subscriptionId: sub.id,
      ...(origin.checkoutSessionId !== undefined && { checkoutSessionId: origin.checkoutSessionId }),
      planId: sub.planId,
      ...(after.planPriceId !== null && { planPriceId: after.planPriceId }),
      currency: after.currency,
      amount: after.amount,
      data: { planSlug: sub.planSlug, before: loggedPrice(change.before), after, cause: origin.cause },
    },
    origin.log,
  );
}
