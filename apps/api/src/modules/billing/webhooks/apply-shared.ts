/**
 * What every applier shares: the context an event is applied in, the amount
 * gate, the rule about terminal subscriptions, and how an event finds the
 * local subscription it is about.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { Subscription } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { MAX_PRICE_AMOUNT } from '@rekey.dev/shared-types';
import { checkoutSessionMatchers, couponForSession } from '../checkout-sessions.js';

export interface ApplyContext {
  log: FastifyBaseLogger;
  /**
   * The provider module whose webhook produced this event ('stripe' etc).
   * The pipeline always sets it. Without it a payment falls back to its
   * subscription's provider, and an unapplied case records 'unknown' rather
   * than a guess that would send an operator to the wrong dashboard.
   */
  provider?: string;
  /**
   * The mode of the credentials the event was verified with. A completion for
   * a checkout recorded in the other mode is not applied. Absent on hand-built
   * test contexts, which skips that check.
   */
  mode?: 'test' | 'live';
  /** Record why an event was acknowledged without being applied, on its webhook receipt. */
  note?: (text: string) => void;
}

/**
 * The largest amount a payment row can hold, in the smallest currency unit:
 * `payments.amount` is a 32-bit column. An amount above it cannot be stored,
 * and an insert that tried would fail the delivery on every retry.
 */
export const MAX_PAYMENT_AMOUNT = MAX_PRICE_AMOUNT;

/**
 * Statuses a subscription never comes back from.
 *
 * CANCELED and EXPIRED are the end of the relationship: the buyer asked to
 * stop, or the finite cycle count ran out. Re-subscribing is a NEW checkout,
 * which walks its own row back through PENDING first, so nothing legitimate
 * needs to write a live status straight onto a terminal one.
 */
export const TERMINAL_STATUSES = new Set<Subscription['status']>(['CANCELED', 'EXPIRED']);

/**
 * Whether a provider event may move a local subscription from `from` to `to`.
 *
 * The status mirror used to write `ev.status` absolutely, with the transition
 * test gating only the outbound announcement. So a single stale `ACTIVE` event,
 * a provider re-delivery, or the pipeline's own documented re-attempt path
 * for an event whose first dispatch failed, silently resurrected a CANCELED
 * subscription, and `ACTIVE` is an entitling status, so everything the buyer
 * had cancelled came back with it.
 *
 * The rule is the narrowest one that closes it: a terminal state is never
 * reopened. Everything else still mirrors absolutely, because for a live
 * subscription the provider genuinely is the authority on the order of its own
 * events and we have no clock to order them by.
 */
export function transitionAllowed(from: Subscription['status'], to: Subscription['status']): boolean {
  if (!TERMINAL_STATUSES.has(from)) return true;
  // CANCELED → EXPIRED and back is bookkeeping between two dead states; neither
  // entitles anyone, so it costs nothing to mirror.
  return TERMINAL_STATUSES.has(to);
}

/**
 * The cancellation stamps a subscription sheds when it becomes live again.
 *
 * `Subscription` is unique on `(applicationId, endUserId, planId)`, so a buyer
 * who cancels and then buys the same plan again does not get a new row, the
 * checkout reuses the cancelled one, walking it back to PENDING and then to
 * ACTIVE. Until now nothing on that journey ever cleared `cancelAt`, and the
 * only code that cleared it at all was Stripe-specific (the status mirror,
 * which writes whatever `ev.cancelAt` carries). PayPal and hand-provisioned
 * subscriptions carried the old dates forward forever.
 *
 * A live subscription wearing a stale `cancelAt` is not a display bug. It is
 * the state a buyer cannot get out of:
 *
 *   - the account panel calls it "Cancelling", shows "Ends <a date in the
 *     past>", and in that branch renders Resubscribe INSTEAD of the Cancel
 *     button;
 *   - `cancelCurrentSubscription` short-circuits on
 *     `if (atPeriodEnd && sub.cancelAt !== null) return sub`, so a direct
 *     cancel call answers 200 having done nothing at all;
 *   - meanwhile the provider is still charging, on schedule.
 *
 * `canceledAt` goes with it. It is the "this subscription is over" timestamp;
 * leaving it set on a subscription that is demonstrably not over misreports
 * the row to the panel, the admin surfaces, and anything reading history.
 *
 * Applied ONLY on a genuine transition into ACTIVE, never on a replay of an
 * activation for a row already ACTIVE. Providers re-deliver webhooks routinely,
 * and clearing unconditionally would let a re-delivery silently un-cancel a
 * cancellation the buyer had scheduled, the same defect pointed the other way.
 */
export const clearedOnReactivation = { cancelAt: null, canceledAt: null } as const;

export function safeAmount(
  raw: number | null | undefined,
  log: FastifyBaseLogger,
  context: { providerPaymentId: string; field: string },
): number | null {
  if (raw == null) return 0;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
    log.warn(context, 'webhook amount is non-finite/non-integer/negative, dropping');
    return null;
  }
  if (raw > MAX_PAYMENT_AMOUNT) {
    log.error(
      { ...context, raw, max: MAX_PAYMENT_AMOUNT },
      'webhook amount exceeds MAX_PAYMENT_AMOUNT, refusing to record. Probable unit mismatch.',
    );
    return null;
  }
  return raw;
}

/**
 * Redeem the coupon a completed checkout session carried, if it carried one.
 *
 * Called from BOTH the checkout appliers and the payment applier, because
 * neither one alone sees every sale: a one-time purchase completes without
 * ever producing an invoice event, and a recurring one is only settled by the
 * invoice. `redeemForCheckout` is idempotent per (coupon, session), so the
 * overlap costs a query and nothing else.
 *
 * Never throws, and never runs inside a caller's transaction: an exhausted
 * coupon must not be able to undo a payment write. What it could not record
 * is logged at warn, the operator's coupon books being one row short is a
 * thing to look at, not a thing to fail a webhook over.
 */
export async function redeemSessionCoupon(
  args: {
    subscription: Pick<Subscription, 'id' | 'applicationId' | 'endUserId' | 'metadata'>;
    checkoutSessionId: string;
    paymentId?: string | undefined;
  },
  ctx: ApplyContext,
): Promise<void> {
  const coupon = couponForSession(args.subscription.metadata, args.checkoutSessionId);
  if (!coupon) return;
  // Dynamic import: coupons → billing → webhooks is otherwise a cycle.
  const { couponsService } = await import('../../coupons/coupons.service.js');
  const outcome = await couponsService.redeemForCheckout({
    couponId: coupon.couponId,
    applicationId: args.subscription.applicationId,
    endUserId: args.subscription.endUserId,
    checkoutSessionId: args.checkoutSessionId,
    subscriptionId: args.subscription.id,
    discountAmount: coupon.discountAmount,
    ...(coupon.currency !== undefined && { currency: coupon.currency }),
    // Hand back the checkout's reservation against `maxRedemptions`. Absent
    // for unlimited coupons and for sessions written before holds existed;
    // `redeemForCheckout` treats it as optional and a stale one expires anyway.
    ...(coupon.holdId !== undefined && { holdId: coupon.holdId }),
    ...(args.paymentId !== undefined && { paymentId: args.paymentId }),
  });
  if (outcome.recorded === false && outcome.reason === 'limit-reached') {
    ctx.log.warn(
      {
        couponId: coupon.couponId,
        subscriptionId: args.subscription.id,
        checkoutSessionId: args.checkoutSessionId,
        code: outcome.code,
      },
      'coupon discount was applied but its redemption could not be recorded, limit reached',
    );
  }
}

/**
 * Local-subscription matcher shared by the payment/status appliers.
 * `providerSubId` is the historical (Stripe) key; `checkoutSessionId`, when
 * a module supplies it, ORs in the checkout-time metadata match (Razorpay
 * events can precede the event that persists `providerSubId`). Returns null
 * when the event carries nothing to match on.
 */
export function localSubscriptionWhere(
  applicationId: string,
  providerSubscriptionId: string | null,
  checkoutSessionId: string | undefined,
):
  | { applicationId: string; providerSubId: string }
  | { applicationId: string; OR: object[] }
  | null {
  // Truthiness is the whole contract here: an empty string, null or undefined
  // must all yield `null` from this function, because each one turns into a
  // filter that matches the wrong rows rather than no rows.
  if (providerSubscriptionId && !checkoutSessionId) {
    // Exactly the historical query, no OR clause for Stripe/PayPal.
    return { applicationId, providerSubId: providerSubscriptionId };
  }
  const or: object[] = [];
  if (providerSubscriptionId) or.push({ providerSubId: providerSubscriptionId });
  if (checkoutSessionId) {
    // Any session the row has issued, not just its newest, see
    // checkout-sessions.ts for why a row can have several live at once.
    or.push(...checkoutSessionMatchers(checkoutSessionId));
  }
  return or.length > 0 ? { applicationId, OR: or } : null;
}

/**
 * The local subscription an event may act on: the row its ids match, unless
 * that row was created by a DIFFERENT provider. Provider subscription ids
 * are not secret (a Stripe id is on every invoice), and the external module
 * accepts whatever id its sender chooses, so an event verified with one
 * provider's credentials must not reach a row that belongs to another. A
 * row with no provider (a legacy or hand-granted one) is fair game, as it
 * always was; contexts without a provider (tests) keep the historical
 * behaviour.
 */
export async function findOwnedSubscription(
  where: NonNullable<ReturnType<typeof localSubscriptionWhere>>,
  ctx: ApplyContext,
): Promise<Subscription | null> {
  const row = await prisma.subscription.findFirst({ where });
  if (!row || !ctx.provider || row.provider === null || row.provider === ctx.provider) return row;
  ctx.log.warn(
    { subscriptionId: row.id, rowProvider: row.provider, eventProvider: ctx.provider },
    'billing event matched a subscription created by another provider, ignored',
  );
  return null;
}

export function metadataObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
