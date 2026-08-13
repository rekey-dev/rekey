/**
 * Shared domain appliers for normalized billing events
 * (docs/specs/billing-provider-modules.md, P0).
 *
 * These are the former per-provider handler bodies (stripe.handler.ts)
 * extracted behind the `DomainBillingEvent` shapes so every provider module
 * shares ONE implementation of "money moved / status changed". Provider
 * payload shapes and status maps stay in the modules' `translate`; this
 * file owns the domain writes.
 *
 * The atomicity contract from the July audit is load-bearing and preserved,
 * with one deliberate narrowing:
 *   - Payment row + subscription status change commit in ONE $transaction.
 *   - Coupon redemption is NO LONGER in that transaction. It was, and it could
 *     therefore undo a payment: a coupon whose limit had since been reached
 *     threw from inside the transaction and rolled back a renewal that the
 *     provider had already collected. A redemption is bookkeeping; a payment
 *     is money. Redemption runs post-commit, is idempotent per (coupon,
 *     checkout session), and reports failure instead of raising it.
 *   - P2002 on the unique (application_id, provider_payment_id) = webhook
 *     replay → the whole transaction rolls back and the applier skips
 *     silently.
 *   - Outbound OUTBOX ROWS are written inside the same $transaction as the
 *     state change they announce (`enqueuePaymentEvent` /
 *     `enqueueSubscriptionEvent` take the tx client), gated on a NEWLY
 *     recorded payment / an actual status transition — replays announce
 *     nothing. Only the first delivery ATTEMPT is post-commit
 *     (`kickDeliveries`), and skipping even that only costs latency: the row
 *     is PENDING with nextAttemptAt=now, so the poller re-attempts it.
 *
 *     This used to be a detached `void (async () => …)()` that re-read the DB
 *     after the commit. A pod rotation or a pool timeout in that gap lost
 *     `payment.succeeded` permanently, because there was no row for the poller
 *     to find. The word "outbox" was already in these comments; it is now true.
 *   - Dunning calls still run strictly POST-commit — they are their own state
 *     machine with their own transactions, not part of this one.
 *   - Entitlements provisioning semantics unchanged (idempotent per period;
 *     first period pinned to the 'initial' anchor).
 */

import type { FastifyBaseLogger } from 'fastify';
import type { Subscription } from '@prisma/client';
import { isEntitlingStatus } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { entitlementsService } from '../entitlements.service.js';
import { dunningService } from '../dunning.service.js';
import {
  checkoutSessionMatchers,
  checkoutSessionWhere,
  couponForSession,
  providerForSession,
  recordUnappliedCompletion,
} from '../checkout-sessions.js';
import { advanceBillingPeriod } from './period.js';
import { enqueuePaymentEvent, enqueueSubscriptionEvent } from './billing-events.js';
import { kickDeliveries } from '../../webhooks/webhook.service.js';
import type {
  CheckoutApprovedEvent,
  CheckoutCompletedEvent,
  DomainBillingEvent,
  PaymentFailedEvent,
  PaymentRefundedEvent,
  PaymentSucceededEvent,
  SubscriptionPeriodAdvancedEvent,
  SubscriptionStatusEvent,
} from '../providers/module-types.js';
import type { BillingProviderName } from '../credentials.service.js';

export interface ApplyContext {
  log: FastifyBaseLogger;
}

/**
 * Maximum payment amount we'll accept on an inbound webhook, in the
 * smallest currency unit. 100 million USD-equivalent is comfortably
 * above any realistic single-transaction ceiling and well below
 * `Number.MAX_SAFE_INTEGER`. Anything past this is almost certainly a
 * provider-side unit mismatch (dollars vs cents) or a bug, and we'd
 * rather log+ignore than write a poisoned Payment row that downstream
 * dashboards try to sum.
 */
const MAX_PAYMENT_AMOUNT = 10_000_000_000; // 100,000,000.00

/**
 * Statuses a subscription never comes back from.
 *
 * CANCELED and EXPIRED are the end of the relationship: the buyer asked to
 * stop, or the finite cycle count ran out. Re-subscribing is a NEW checkout,
 * which walks its own row back through PENDING first — so nothing legitimate
 * needs to write a live status straight onto a terminal one.
 */
const TERMINAL_STATUSES = new Set<Subscription['status']>(['CANCELED', 'EXPIRED']);

/**
 * Whether a provider event may move a local subscription from `from` to `to`.
 *
 * The status mirror used to write `ev.status` absolutely, with the transition
 * test gating only the outbound announcement. So a single stale `ACTIVE` event
 * — a provider re-delivery, or the pipeline's own documented re-attempt path
 * for an event whose first dispatch failed — silently resurrected a CANCELED
 * subscription, and `ACTIVE` is an entitling status, so everything the buyer
 * had cancelled came back with it.
 *
 * The rule is the narrowest one that closes it: a terminal state is never
 * reopened. Everything else still mirrors absolutely, because for a live
 * subscription the provider genuinely is the authority on the order of its own
 * events and we have no clock to order them by.
 */
function transitionAllowed(from: Subscription['status'], to: Subscription['status']): boolean {
  if (!TERMINAL_STATUSES.has(from)) return true;
  // CANCELED → EXPIRED and back is bookkeeping between two dead states; neither
  // entitles anyone, so it costs nothing to mirror.
  return TERMINAL_STATUSES.has(to);
}

/**
 * The cancellation stamps a subscription sheds when it becomes live again.
 *
 * `Subscription` is unique on `(applicationId, endUserId, planId)`, so a buyer
 * who cancels and then buys the same plan again does not get a new row — the
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
 *     `if (atPeriodEnd && sub.cancelAt !== null) return sub` — so a direct
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
 * cancellation the buyer had scheduled — the same defect pointed the other way.
 */
const clearedOnReactivation = { cancelAt: null, canceledAt: null } as const;

function safeAmount(
  raw: number | null | undefined,
  log: FastifyBaseLogger,
  context: { providerPaymentId: string; field: string },
): number | null {
  if (raw == null) return 0;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
    log.warn(context, 'webhook amount is non-finite/non-integer/negative — dropping');
    return null;
  }
  if (raw > MAX_PAYMENT_AMOUNT) {
    log.error(
      { ...context, raw, max: MAX_PAYMENT_AMOUNT },
      'webhook amount exceeds MAX_PAYMENT_AMOUNT — refusing to record. Probable unit mismatch.',
    );
    return null;
  }
  return raw;
}

/**
 * How far above the plan's own price a single charge may land before we treat
 * it as a unit mismatch rather than a sale.
 *
 * 100× is the classic dollars-recorded-as-cents error, and it is the shape this
 * is here to catch. Real charges do exceed `plan.amount` — tax, proration, a
 * mid-period upgrade — but never by two orders of magnitude, and a charge that
 * big is a number no revenue dashboard should be asked to sum.
 */
const MAX_PLAN_AMOUNT_MULTIPLE = 100;

/**
 * Cross-check the money on a webhook against the plan it claims to be paying
 * for, and return the currency to record.
 *
 * The amount and currency arrive as provider payload fields and were written
 * verbatim: `safeAmount` bounded the amount absolutely, and the currency was
 * taken as given with a hardcoded `'usd'` when absent — so an INR plan whose
 * event omitted the currency recorded USD rows, and every per-currency total an
 * operator reads was a sum over a column nobody had checked. A charge in a
 * currency the plan is not sold in is not a rounding difference; it means the
 * event and the local row disagree about what was bought, so it is refused
 * rather than recorded and averaged in later.
 *
 * Returns null when the charge must not be recorded. An event that matched no
 * local subscription has nothing to check against and keeps the historical
 * pass-through — the unlinked-payment posture is `requireLocalSubscription`'s
 * to decide, not this function's.
 */
async function resolveChargeCurrency(
  localSub: Pick<Subscription, 'id' | 'planId'> | null,
  charge: { amount: number; currency: string | null | undefined },
  log: FastifyBaseLogger,
  context: { providerPaymentId: string },
): Promise<string | null> {
  if (!localSub) return (charge.currency ?? 'usd').toUpperCase();
  const plan = await prisma.plan.findUnique({
    where: { id: localSub.planId },
    select: { currency: true, amount: true, kind: true, slug: true },
  });
  if (!plan) return (charge.currency ?? 'usd').toUpperCase();

  const planCurrency = plan.currency.toUpperCase();
  // An absent currency inherits the PLAN's, not USD — the old default silently
  // mislabelled every non-USD provider that omits the field.
  const currency = (charge.currency ?? planCurrency).toUpperCase();
  if (currency !== planCurrency) {
    log.error(
      { ...context, subscriptionId: localSub.id, planSlug: plan.slug, currency, planCurrency },
      'webhook currency does not match the plan currency — refusing to record',
    );
    return null;
  }

  // USAGE plans bill on consumption and a zero-amount plan has no price to
  // compare against, so neither has a meaningful ceiling here.
  // `>=`, not `>`. The classic failure this catches is a major-units amount
  // recorded as minor units, which is a clean 100× — and with a multiple of
  // 100 that lands exactly ON the boundary, so a strict `>` let through the
  // single most likely instance of the bug the guard exists for.
  if (plan.kind !== 'USAGE' && plan.amount > 0 && charge.amount >= plan.amount * MAX_PLAN_AMOUNT_MULTIPLE) {
    log.error(
      {
        ...context,
        subscriptionId: localSub.id,
        planSlug: plan.slug,
        amount: charge.amount,
        planAmount: plan.amount,
      },
      'webhook amount exceeds the plan price by more than MAX_PLAN_AMOUNT_MULTIPLE — refusing to record. Probable unit mismatch.',
    );
    return null;
  }
  return currency;
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
 * is logged at warn — the operator's coupon books being one row short is a
 * thing to look at, not a thing to fail a webhook over.
 */
async function redeemSessionCoupon(
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
      'coupon discount was applied but its redemption could not be recorded — limit reached',
    );
  }
}

/** Dispatch one normalized event to its applier. Used by the pipeline. */
export async function applyBillingEvent(ev: DomainBillingEvent, ctx: ApplyContext): Promise<void> {
  switch (ev.type) {
    case 'checkout.completed':
      return applyCheckoutCompleted(ev, ctx);
    case 'checkout.approved':
      return applyCheckoutApproved(ev, ctx);
    case 'payment.succeeded':
      return applyPaymentSucceeded(ev, ctx);
    case 'payment.failed':
      return applyPaymentFailed(ev, ctx);
    case 'payment.refunded':
      return applyPaymentRefunded(ev, ctx);
    case 'subscription.activated':
      return applySubscriptionActivated(ev, ctx);
    case 'subscription.canceled':
      return applySubscriptionCanceled(ev, ctx);
    case 'subscription.past_due':
      return applySubscriptionPastDue(ev, ctx);
    case 'subscription.period_advanced':
      return applySubscriptionPeriodAdvanced(ev, ctx);
  }
}

/**
 * Hosted checkout completed: the local PENDING subscription (matched by any
 * checkout-session id the row has issued — see checkout-sessions.ts) flips
 * ACTIVE, the provider's subscription id is persisted for future event
 * matching, and the plan's entitlements are provisioned for the FIRST period.
 *
 * This is also where a ONE-TIME purchase is fully accounted for: it is the
 * only event either Stripe or PayPal produces for a `mode: 'payment'` sale, so
 * both the `Payment` row (when the payload carries the charge) and the coupon
 * redemption have to land here or they never land at all.
 */
export async function applyCheckoutCompleted(
  ev: CheckoutCompletedEvent,
  ctx: ApplyContext,
): Promise<void> {
  // Same hazard the status mirror carried: an empty identifier does not match
  // nothing, it matches the wrong rows. `checkoutSessionWhere` builds a JSON
  // path filter, and Prisma strips an `undefined` operator — leaving a filter
  // that can match every subscription in the application, which the
  // `updateMany` below would then mark ACTIVE. The type says `string`; only
  // PayPal's translator enforces it.
  if (!ev.checkoutSessionId) {
    ctx.log.warn(
      { applicationId: ev.applicationId, type: ev.type },
      'checkout event carries no session id — ignored',
    );
    return;
  }
  const where = checkoutSessionWhere(ev.applicationId, ev.checkoutSessionId);
  // Pre-transition snapshot so the outbound `subscription.activated` event
  // fires only on a REAL state change — a replayed event whose row is
  // already ACTIVE must not re-announce.
  const before = await prisma.subscription.findFirst({
    where,
    select: { id: true, status: true, provider: true, providerSubId: true, metadata: true },
  });
  // Same terminal-state guard the status mirror applies, and for the same
  // reason: a re-delivered completion for an old session must not resurrect a
  // subscription the buyer cancelled. A genuine re-subscribe is not affected —
  // its checkout walks the row back to PENDING before this event arrives.
  if (before && !transitionAllowed(before.status, 'ACTIVE')) {
    ctx.log.warn(
      {
        subscriptionId: before.id,
        currentStatus: before.status,
        sessionId: ev.checkoutSessionId,
        providerEventId: ev.providerEventId,
      },
      'checkout completion would reopen a terminal subscription — refusing the write',
    );
    return;
  }

  // A SECOND completion against a subscription that is already live.
  //
  // One row can hold several completable sessions at once, by design: the
  // buyer who opens checkout twice reuses the row (see checkout-sessions.ts),
  // and `createCheckoutSession` deliberately lets the second one be opened at
  // a different processor, because both sessions survive either way and
  // refusing would block "picked PayPal, went back, chose Stripe" without
  // closing anything. That decision names this function as the place the
  // damage is stopped. Nothing here stopped it: `transitionAllowed('ACTIVE',
  // 'ACTIVE')` passes, so the second completion overwrote `providerSubId` and
  // the FIRST provider-side subscription became unreachable — cancel could
  // never find it and it billed forever, in a processor's dashboard nobody was
  // looking at.
  //
  // The discriminator is the provider subscription id, not the fact of a
  // second event, because a re-delivery carries the SAME id and has to stay
  // idempotent. A resubscribe is not caught either: its checkout walks the row
  // back to PENDING, which is not entitling.
  //
  // Refusing keeps the row pointing at the relationship that settled first.
  // The other one still exists and is still charging, so it is recorded on the
  // row rather than only in a log line nobody can query later.
  if (
    before &&
    isEntitlingStatus(before.status) &&
    before.providerSubId !== null &&
    ev.providerSubscriptionId !== null &&
    before.providerSubId !== ev.providerSubscriptionId
  ) {
    ctx.log.error(
      {
        subscriptionId: before.id,
        applicationId: ev.applicationId,
        heldProvider: before.provider,
        heldProviderSubId: before.providerSubId,
        orphanedProvider: providerForSession(before.metadata, ev.checkoutSessionId),
        orphanedProviderSubId: ev.providerSubscriptionId,
        sessionId: ev.checkoutSessionId,
        providerEventId: ev.providerEventId,
      },
      'a second checkout completed against an already-live subscription — refusing to overwrite ' +
        'the provider subscription id; the newly completed one is live at its processor and is ' +
        'not cancellable from here',
    );
    await prisma.subscription.update({
      where: { id: before.id },
      data: {
        metadata: recordUnappliedCompletion(before.metadata, {
          checkoutSessionId: ev.checkoutSessionId,
          providerSubId: ev.providerSubscriptionId,
          provider: providerForSession(before.metadata, ev.checkoutSessionId),
          at: new Date().toISOString(),
        }) as never,
      },
    });
    return;
  }

  // Which processor actually completed, as opposed to which one the most
  // recent checkout was opened at. `Subscription.provider` is written by
  // checkout, before anybody has paid, so a buyer who opens Stripe, goes back
  // and opens PayPal, then returns to the first tab and pays leaves the column
  // naming PayPal while `providerSubId` is a Stripe id — and cancel dials the
  // column. Null on rows written before `providerBySession` existed, which
  // leaves the column untouched exactly as before.
  const completingProvider = providerForSession(before?.metadata ?? null, ev.checkoutSessionId);

  // Status flip + its outbox rows in ONE transaction, so a
  // `subscription.activated` announcement can never be lost by a crash between
  // the two. The delivery ATTEMPT is kicked post-commit, at the point the emit
  // used to sit.
  const activatedFrom = before && before.status !== 'ACTIVE' ? before : null;
  const { updated, deliveryIds } = await prisma.$transaction(async (tx) => {
    const result = await tx.subscription.updateMany({
      where,
      data: {
        status: 'ACTIVE',
        ...(ev.providerSubscriptionId !== null && { providerSubId: ev.providerSubscriptionId }),
        ...(completingProvider !== null && { provider: completingProvider }),
        // Activation payloads that carry the period anchor (Razorpay
        // `current_end`, PayPal `billing_info.next_billing_time`) mirror it in
        // the same write; undefined = untouched.
        ...(ev.currentPeriodEnd !== undefined && { currentPeriodEnd: ev.currentPeriodEnd }),
        // A subscription that just came (back) to life is not cancelled, and
        // must not keep wearing the last cancellation's dates. See
        // `clearedOnReactivation`.
        ...(activatedFrom ? clearedOnReactivation : {}),
      },
    });
    // Only on the PENDING→ACTIVE transition (not on replays that found the row
    // already ACTIVE).
    const ids =
      result.count > 0 && activatedFrom
        ? await enqueueSubscriptionEvent(tx, 'subscription.activated', activatedFrom.id)
        : [];
    return { updated: result, deliveryIds: ids };
  });

  // Materialize the plan's entitlements (licenses, credits, …) onto the buyer.
  // Idempotent, and covers both legacy single-kind plans (via synthesizeLegacy)
  // and bundled PlanEntitlement rows.
  if (updated.count > 0) {
    const sub = await prisma.subscription.findFirst({ where });
    if (sub) {
      // Checkout provisions the subscription's FIRST period by default —
      // pinned to the 'initial' anchor so the first invoice.paid
      // (subscription_create) collides with it instead of double-granting
      // (see provision()). PayPal's ACTIVATED port sets firstPeriod: false
      // (its bespoke handler never pinned; identical for fresh activations
      // where currentPeriodEnd is null, current-period-anchored on a
      // suspension→reactivation).
      await entitlementsService.provision({
        subscription: sub,
        log: ctx.log,
        firstPeriod: ev.firstPeriod ?? true,
      });

      // The charge, when the completion payload carried one (one-time flows).
      // Recorded AFTER provisioning so a payment row never exists for a
      // fulfilment that failed, and independently of it so a duplicate
      // delivery re-provisions idempotently without a second payment.
      const paymentId = ev.payment
        ? await recordCompletionPayment(ev, sub, ctx)
        : undefined;

      // Redemption for the one-time flows, which produce no payment event of
      // their own. Idempotent, so the recurring flows redeeming again from
      // `applyPaymentSucceeded` costs a lookup.
      await redeemSessionCoupon(
        { subscription: sub, checkoutSessionId: ev.checkoutSessionId, paymentId },
        ctx,
      );
    }
    // Delivery kickoff for the rows committed above. Deliberately here rather
    // than right after the commit, so a consumer still sees the same ordering
    // it always did: entitlements are provisioned before the activation is
    // announced.
    kickDeliveries(deliveryIds);
    if (activatedFrom) {
      // Reactivation of a suspended (PAST_DUE) sub recovers its dunning case
      // (PayPal BILLING.SUBSCRIPTION.ACTIVATED port). No-op when no case is
      // open — a fresh PENDING→ACTIVE checkout (Stripe) has none.
      await dunningService.recoverForSubscription(activatedFrom.id);
    }
  }

  ctx.log.info(
    { sessionId: ev.checkoutSessionId, applicationId: ev.applicationId, matched: updated.count },
    'checkout completed processed',
  );
}

/**
 * Write the SUCCEEDED `Payment` row for a checkout completion that carried its
 * own charge, and return its id. Returns undefined when nothing was written.
 *
 * Idempotent through the unique `provider_payment_id`, exactly like the
 * payment appliers: a replayed completion hits P2002 and reports the existing
 * row's id so the redemption can still link to it.
 */
async function recordCompletionPayment(
  ev: CheckoutCompletedEvent,
  sub: Subscription,
  ctx: ApplyContext,
): Promise<string | undefined> {
  const charge = ev.payment;
  if (!charge) return undefined;
  const amount = safeAmount(charge.amount, ctx.log, {
    providerPaymentId: charge.providerPaymentId,
    field: 'amount_total',
  });
  if (amount === null) return undefined; // Refused (see safeAmount).
  // Cross-checked against the plan this session bought — see
  // resolveChargeCurrency.
  const currency = await resolveChargeCurrency(sub, { amount, currency: charge.currency }, ctx.log, {
    providerPaymentId: charge.providerPaymentId,
  });
  if (currency === null) return undefined;

  try {
    const { payment, deliveryIds } = await prisma.$transaction(async (tx) => {
      const row = await tx.payment.create({
        data: {
          applicationId: ev.applicationId,
          endUserId: sub.endUserId,
          subscriptionId: sub.id,
          amount,
          currency,
          status: 'SUCCEEDED',
          providerPaymentId: charge.providerPaymentId,
          description: charge.description,
        },
        select: { id: true },
      });
      // Outbox row commits with the payment — see the module docblock.
      return { payment: row, deliveryIds: await enqueuePaymentEvent(tx, 'payment.succeeded', row.id) };
    });
    kickDeliveries(deliveryIds);
    return payment.id;
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    ctx.log.info(
      { providerPaymentId: charge.providerPaymentId },
      'checkout completed: payment already recorded',
    );
    // Scoped by application: the unique key is (application_id,
    // provider_payment_id), and looking the charge id up globally would return
    // ANOTHER tenant's payment row when two Applications share a provider
    // account — which is exactly the collision that key now prevents.
    const existing = await prisma.payment.findUnique({
      where: {
        applicationId_providerPaymentId: {
          applicationId: ev.applicationId,
          providerPaymentId: charge.providerPaymentId,
        },
      },
      select: { id: true },
    });
    return existing?.id;
  }
}

/**
 * Approved-but-uncaptured one-time order (PayPal Orders v2 —
 * CHECKOUT.ORDER.APPROVED). Port of the bespoke paypal.handler
 * `onOrderApproved`: capture via the provider, then flip the local row
 * ACTIVE and provision. Idempotent — the capture tolerates
 * already-captured, and provision dedupes per period. An incomplete
 * capture leaves the row PENDING (deliberately; the provider retries the
 * webhook).
 */
export async function applyCheckoutApproved(
  ev: CheckoutApprovedEvent,
  ctx: ApplyContext,
): Promise<void> {
  // Same hazard the status mirror carried: an empty identifier does not match
  // nothing, it matches the wrong rows. `checkoutSessionWhere` builds a JSON
  // path filter, and Prisma strips an `undefined` operator — leaving a filter
  // that can match every subscription in the application, which the
  // `updateMany` below would then mark ACTIVE. The type says `string`; only
  // PayPal's translator enforces it.
  if (!ev.checkoutSessionId) {
    ctx.log.warn(
      { applicationId: ev.applicationId, type: ev.type },
      'checkout event carries no session id — ignored',
    );
    return;
  }
  const sub = await prisma.subscription.findFirst({
    where: checkoutSessionWhere(ev.applicationId, ev.checkoutSessionId),
    include: { plan: true },
  });
  if (!sub) {
    ctx.log.warn({ orderId: ev.checkoutSessionId }, 'checkout.approved: no local row matches this order');
    return;
  }
  // Refused BEFORE the capture, not after: a terminal row must not be
  // reopened, and taking the buyer's money for one would be worse than the
  // status write. See transitionAllowed.
  if (!transitionAllowed(sub.status, 'ACTIVE')) {
    ctx.log.warn(
      { subscriptionId: sub.id, currentStatus: sub.status, orderId: ev.checkoutSessionId },
      'checkout.approved would reopen a terminal subscription — refusing to capture',
    );
    return;
  }

  // Capture the approved order (the provider doesn't auto-capture — that's
  // what routed us to this applier). Dynamic import breaks the
  // apply ↔ providers/index cycle, same as the credentials service does.
  const { getProviderForApplication } = await import('../providers/index.js');
  const application = await prisma.application.findUniqueOrThrow({
    where: { id: ev.applicationId },
  });
  const provider = await getProviderForApplication(application, ev.provider as BillingProviderName);
  if (provider.captureOneTime) {
    const { captured } = await provider.captureOneTime(ev.checkoutSessionId);
    if (!captured) {
      ctx.log.warn({ orderId: ev.checkoutSessionId }, 'checkout.approved: capture did not complete — leaving PENDING');
      return;
    }
  }

  // Status flip + its outbox row in one transaction. `sub` is the pre-update
  // row, so the transition test reads the status the row had before this event.
  const deliveryIds = await prisma.$transaction(async (tx) => {
    await tx.subscription.updateMany({
      where: { id: sub.id },
      data: { status: 'ACTIVE', providerSubId: ev.checkoutSessionId },
    });
    return sub.status !== 'ACTIVE'
      ? enqueueSubscriptionEvent(tx, 'subscription.activated', sub.id)
      : [];
  });
  await entitlementsService.provision({ subscription: sub, log: ctx.log });
  // Fulfilment happened, so the coupon has been spent. This applier is the
  // ONLY place that knows it for a PayPal one-off: the capture arrives later
  // as its own payment event, and before this existed the redemption was
  // simply never recorded — a single-use code discounted every subsequent
  // purchase by the same buyer, forever.
  await redeemSessionCoupon({ subscription: sub, checkoutSessionId: ev.checkoutSessionId }, ctx);
  // Delivery kickoff, at the point the emit used to sit — after provisioning,
  // so a consumer sees the same ordering it always did.
  kickDeliveries(deliveryIds);
  ctx.log.info(
    { orderId: ev.checkoutSessionId, kind: sub.plan.kind },
    'one-time order captured + fulfilled',
  );
}

/**
 * Successful recurring payment: record the SUCCEEDED Payment row and the
 * subscription's status/period in one transaction, then — strictly after the
 * commit — redeem the checkout's coupon if it has not been already, recover
 * any open dunning case, and (re-)provision entitlements for the paid period.
 */
/**
 * Local-subscription matcher shared by the payment/status appliers.
 * `providerSubId` is the historical (Stripe) key; `checkoutSessionId`, when
 * a module supplies it, ORs in the checkout-time metadata match (Razorpay
 * events can precede the event that persists `providerSubId`). Returns null
 * when the event carries nothing to match on.
 */
function localSubscriptionWhere(
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
    // Exactly the historical query — no OR clause for Stripe/PayPal.
    return { applicationId, providerSubId: providerSubscriptionId };
  }
  const or: object[] = [];
  if (providerSubscriptionId) or.push({ providerSubId: providerSubscriptionId });
  if (checkoutSessionId) {
    // Any session the row has issued, not just its newest — see
    // checkout-sessions.ts for why a row can have several live at once.
    or.push(...checkoutSessionMatchers(checkoutSessionId));
  }
  return or.length > 0 ? { applicationId, OR: or } : null;
}

export async function applyPaymentSucceeded(
  ev: PaymentSucceededEvent,
  ctx: ApplyContext,
): Promise<void> {
  const amount = safeAmount(ev.amount, ctx.log, {
    providerPaymentId: ev.providerPaymentId,
    field: 'amount_paid',
  });
  if (amount === null) return; // Refused (see safeAmount).

  // Find local subscription if present so the Payment links to it.
  const where = localSubscriptionWhere(ev.applicationId, ev.providerSubscriptionId, ev.checkoutSessionId);
  const localSub = where ? await prisma.subscription.findFirst({ where }) : null;
  if (!localSub && ev.requireLocalSubscription) {
    // Razorpay posture: an event that matches no local row records nothing
    // (never write an unlinked Payment for a subscription we don't know).
    ctx.log.warn(
      { providerPaymentId: ev.providerPaymentId, providerSubscriptionId: ev.providerSubscriptionId },
      'payment.succeeded: no local subscription matched — skipping',
    );
    return;
  }
  // Amount + currency cross-checked against the plan before either reaches a
  // row — see resolveChargeCurrency.
  const currency = await resolveChargeCurrency(localSub, { amount, currency: ev.currency }, ctx.log, {
    providerPaymentId: ev.providerPaymentId,
  });
  if (currency === null) return;

  // Idempotent: (application_id, provider_payment_id) is unique; skip on
  // conflict.
  //
  // The coupon redemption is deliberately NOT in this transaction any more.
  // It used to be, on the reasoning that a payment must never commit without
  // its redemption — but the redemption throws on an exhausted limit, and a
  // recurring coupon was being redeemed again on EVERY renewal, so the first
  // renewal after a `maxRedemptionsPerUser: 1` coupon was consumed rolled the
  // renewal payment back: money moved at the provider, no Payment row, no
  // status or period mirror, no re-provisioned entitlements, no dunning
  // recovery, and the provider retried the poisoned event until it gave up.
  // Redemption now runs post-commit and reports rather than throws.
  let createdPayment: { id: string } | null = null;
  let deliveryIds: string[] = [];
  try {
    const committed = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          applicationId: ev.applicationId,
          endUserId: localSub?.endUserId ?? null,
          subscriptionId: localSub?.id ?? null,
          amount,
          currency,
          status: 'SUCCEEDED',
          providerPaymentId: ev.providerPaymentId,
          description: ev.description ?? null,
        },
        select: { id: true },
      });
      // Flip the subscription ACTIVE (and mirror a payload-carried period
      // anchor, e.g. Razorpay current_end) in the SAME transaction as the
      // payment — a committed payment must never be left with a stale
      // status or stranded from its period change.
      if (localSub) {
        // The payment is recorded either way — money that moved is a fact —
        // but a charge arriving against a CANCELED/EXPIRED row does not bring
        // it back to life. See transitionAllowed.
        const mayActivate =
          localSub.status !== 'ACTIVE' && transitionAllowed(localSub.status, 'ACTIVE');
        const subData = {
          ...(mayActivate && { status: 'ACTIVE' as const }),
          ...(ev.currentPeriodEnd !== undefined && { currentPeriodEnd: ev.currentPeriodEnd }),
          // A PENDING row going live on its payment is a checkout completing,
          // and a resubscribe reuses the cancelled row — so the old dates have
          // to go (see `clearedOnReactivation`). This path matters because the
          // two events are not ordered: when a provider's sale lands before its
          // activation, the activation then finds the row already ACTIVE and
          // clears nothing, so without this the stale `cancelAt` survives.
          //
          // Deliberately NOT extended to PAST_DUE → ACTIVE. That is dunning
          // recovery, where a cancellation the buyer scheduled is still theirs;
          // clearing it there would quietly restart a subscription they had
          // stopped, which is the failure that costs them money.
          ...(mayActivate && localSub.status === 'PENDING' ? clearedOnReactivation : {}),
        };
        if (Object.keys(subData).length > 0) {
          await tx.subscription.update({ where: { id: localSub.id }, data: subData });
        }
      }
      // Outbox rows, same transaction as the money — only when a NEW payment
      // row was committed, which by construction is every path that reaches
      // here (a replay throws P2002 above and rolls the whole thing back).
      const ids = await enqueuePaymentEvent(tx, 'payment.succeeded', payment.id);
      if (localSub && localSub.status !== 'ACTIVE' && transitionAllowed(localSub.status, 'ACTIVE')) {
        // Recovery/activation via payment — a real status transition. Refused
        // above for a terminal row, so nothing is announced for one either.
        ids.push(...(await enqueueSubscriptionEvent(tx, 'subscription.activated', localSub.id)));
      }
      return { payment, deliveryIds: ids };
    });
    createdPayment = committed.payment;
    deliveryIds = committed.deliveryIds;
  } catch (e) {
    // P2002 = this provider payment id already has a Payment row for this
    // application (webhook replay) — the original transaction committed
    // payment + status + outbox rows together, so skipping here is safe.
    // Anything else rolls all back and rethrows.
    if ((e as { code?: string }).code === 'P2002') {
      ctx.log.info(
        { providerPaymentId: ev.providerPaymentId },
        'payment.succeeded: payment already recorded',
      );
    } else {
      throw e;
    }
  }

  // First delivery attempt for the rows committed above. A replayed payment
  // (P2002 → deliveryIds stays empty) announces nothing.
  kickDeliveries(deliveryIds);

  // Coupon redemption — post-commit, and keyed on the session the EVENT names,
  // never on whichever session the row issued most recently.
  //
  // It was the newest, and that was a free drain on a coupon's global ceiling:
  // the row's newest session is whatever checkout the buyer opened last, so
  // opening a fresh discounted checkout and then letting the existing
  // subscription renew redeemed the NEW session's coupon off a renewal invoice
  // that the new coupon never touched — no payment for it, repeatable monthly.
  //
  // Every flow that reaches here carries its session or is already covered:
  // Razorpay puts the subscription/payment-link id on the event, PayPal's
  // capture carries the order id, and Stripe's one-time and recurring sales are
  // both redeemed by `checkout.completed`, which knows exactly which session
  // completed. A renewal names no session and redeems nothing, which is the
  // correct answer — the provider coupon is `duration: 'once'` and only ever
  // cut invoice #1.
  if (localSub && ev.checkoutSessionId) {
    await redeemSessionCoupon(
      {
        subscription: localSub,
        checkoutSessionId: ev.checkoutSessionId,
        paymentId: createdPayment?.id,
      },
      ctx,
    );
  }

  // Money moved for this subscription — whatever the status-mirror ordering,
  // an OPEN dunning case is now recovered (no-op when none is open).
  if (localSub) {
    await dunningService.recoverForSubscription(localSub.id);
  }

  // Re-provision on every successful payment — this is the recurring-renewal
  // event, so a CREDIT plan refills its per-period credits and a TIMED license
  // extends. `provision()` is idempotent per (subscription, period): its credit
  // anchor is keyed off `currentPeriodEnd`, so a replay within the same period
  // is a no-op while the next billing period (advanced by the status mirror)
  // gets a distinct key and grants fresh credits. Without this, recurring credit
  // packs were granted once at checkout and never refilled. Re-read the row so
  // we provision against the latest currentPeriodEnd.
  if (localSub) {
    const fresh = await prisma.subscription.findUnique({ where: { id: localSub.id } });
    if (fresh) {
      // The FIRST payment provisions the SAME period checkout already did —
      // anchor it 'initial' so the two collide rather than double-grant when
      // the period mirror has already advanced currentPeriodEnd (providers
      // don't order webhooks). Renewals anchor on currentPeriodEnd and refill
      // once each.
      await entitlementsService.provision({
        subscription: fresh,
        log: ctx.log,
        firstPeriod: ev.firstPeriod,
      });
    }
  }
}

/**
 * Failed payment: record the FAILED Payment row and flip the subscription
 * PAST_DUE atomically, then (post-commit, new-payment-gated) emit and open
 * or bump the dunning case.
 */
export async function applyPaymentFailed(ev: PaymentFailedEvent, ctx: ApplyContext): Promise<void> {
  const where = localSubscriptionWhere(ev.applicationId, ev.providerSubscriptionId, ev.checkoutSessionId);
  const localSub = where ? await prisma.subscription.findFirst({ where }) : null;
  if (!localSub && ev.requireLocalSubscription) {
    ctx.log.warn(
      { providerPaymentId: ev.providerPaymentId, providerSubscriptionId: ev.providerSubscriptionId },
      'payment.failed: no local subscription matched — skipping',
    );
    return;
  }

  const failedAmount = safeAmount(ev.amount, ctx.log, {
    providerPaymentId: ev.providerPaymentId,
    field: 'amount_due',
  });
  if (failedAmount === null) return;

  // Record the FAILED payment, flip the subscription to PAST_DUE, and write
  // the outbox rows atomically: a committed payment must never be left behind
  // without its matching status change, and neither must be left without the
  // event that announces it. Idempotent — (application_id,
  // provider_payment_id) is unique, so a webhook replay hits P2002 and the
  // whole transaction rolls back cleanly.
  let createdPayment: { id: string } | null = null;
  let deliveryIds: string[] = [];
  try {
    const committed = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          applicationId: ev.applicationId,
          endUserId: localSub?.endUserId ?? null,
          subscriptionId: localSub?.id ?? null,
          amount: failedAmount,
          currency: (ev.currency ?? 'usd').toUpperCase(),
          status: 'FAILED',
          providerPaymentId: ev.providerPaymentId,
          description: ev.description ?? null,
        },
        select: { id: true },
      });
      if (localSub) {
        await tx.subscription.update({
          where: { id: localSub.id },
          data: { status: 'PAST_DUE' },
        });
      }
      const ids = await enqueuePaymentEvent(tx, 'payment.failed', payment.id);
      if (localSub && localSub.status !== 'PAST_DUE') {
        ids.push(...(await enqueueSubscriptionEvent(tx, 'subscription.past_due', localSub.id)));
      }
      return { payment, deliveryIds: ids };
    });
    createdPayment = committed.payment;
    deliveryIds = committed.deliveryIds;
  } catch (e) {
    // P2002 = this provider payment id already recorded a FAILED payment
    // (replay) — the original transaction committed payment + status
    // together, so skipping is safe. Anything else rolls both back and
    // rethrows for the provider to retry.
    if ((e as { code?: string }).code === 'P2002') {
      ctx.log.info({ providerPaymentId: ev.providerPaymentId }, 'payment.failed: already recorded');
    } else {
      throw e;
    }
  }

  // Side effects fire only after the transaction commits, and only when a NEW
  // failed payment was recorded (replays deliver nothing / don't re-bump
  // dunning).
  kickDeliveries(deliveryIds);
  if (createdPayment && localSub) {
    // Open (or bump) the dunning case. The provider keeps retrying the card
    // itself — the case tracks state + notifies; it never re-charges.
    await dunningService.recordPaymentFailure({ subscriptionId: localSub.id, log: ctx.log });
  }
}

/**
 * Refund applier — documented no-op stub. No provider handler records
 * refunds today (the Stripe dispatcher has no `charge.refunded` /
 * `refund.*` coverage), so there is no behavior to extract; the event
 * exists so modules can translate into it once the domain grows a
 * REFUNDED payment status / negative-amount policy. Logged so operators
 * can see refund traffic arriving before it's modeled.
 */
export async function applyPaymentRefunded(
  ev: PaymentRefundedEvent,
  ctx: ApplyContext,
): Promise<void> {
  // Records the reversal on the books. It does NOT revoke what the payment
  // bought — clawing back credits, licences and subscriptions is #413, and
  // needs a dispute policy, a negative-balance primitive and a restore path
  // for a dispute the operator wins. Until then the operator reverses credits
  // with `credits.grant({ reason: 'ADJUST', amount: -n })`, which is audited.
  //
  // Writing the status is still worth doing on its own: without it the
  // operator's payment list and revenue figures disagree with the provider,
  // and `PaymentStatus.REFUNDED` was a value three routes could filter on and
  // nothing ever wrote.
  const { count } = await prisma.payment.updateMany({
    where: {
      applicationId: ev.applicationId,
      providerPaymentId: ev.providerPaymentId,
      status: 'SUCCEEDED',
    },
    data: { status: 'REFUNDED' },
  });

  ctx.log.info(
    {
      providerPaymentId: ev.providerPaymentId,
      applicationId: ev.applicationId,
      marked: count,
    },
    count > 0
      ? 'payment.refunded — payment marked REFUNDED; entitlements NOT revoked (see #413)'
      : 'payment.refunded — no matching succeeded payment; recorded only',
  );
}

export async function applySubscriptionActivated(
  ev: SubscriptionStatusEvent,
  ctx: ApplyContext,
): Promise<void> {
  return applySubscriptionStatusMirror(ev, ctx);
}

export async function applySubscriptionCanceled(
  ev: SubscriptionStatusEvent,
  ctx: ApplyContext,
): Promise<void> {
  return applySubscriptionStatusMirror(ev, ctx);
}

export async function applySubscriptionPastDue(
  ev: SubscriptionStatusEvent,
  ctx: ApplyContext,
): Promise<void> {
  return applySubscriptionStatusMirror(ev, ctx);
}

/**
 * Status mirror shared by the three lifecycle appliers — the former
 * onSubscriptionUpdated/onSubscriptionDeleted bodies unified. `ev.status`
 * (the module's mapped local status) drives everything; `ev.type` only
 * routed us here (see SubscriptionStatusEvent docs for why they can
 * diverge for EXPIRED/PENDING).
 *
 * Timestamp fields follow undefined-means-untouched: subscription.updated
 * mirrors all three absolutely (null clears), subscription.deleted sets
 * only canceledAt.
 */
async function applySubscriptionStatusMirror(
  ev: SubscriptionStatusEvent,
  ctx: ApplyContext,
): Promise<void> {
  // No identifier, no write. `localSubscriptionWhere` returns null only when
  // the event carries neither a provider subscription id nor a checkout
  // session id — nothing that names a row.
  //
  // This used to fall back to `{ applicationId, providerSubId: <the id we just
  // established is missing> }`. Prisma drops an `undefined` filter entirely, so
  // that collapsed to `{ applicationId }` and the `updateMany` below mirrored
  // the payload's status onto EVERY subscription in the application; a `null`
  // was worse in a different way, matching every row with no provider — which
  // on a deployment where subscriptions are granted rather than checked out is
  // all of them. One `customer.subscription.deleted` missing its `id` cancels
  // the whole application; one `updated` with `status: active` entitles every
  // abandoned checkout in it. `transitionAllowed` does not save it, because it
  // is evaluated against a single sampled row and then applied to all of them.
  //
  // The type says `providerSubscriptionId: string`, which is why the fallback
  // looked unreachable. Only PayPal's translator actually enforces it; Stripe
  // and Razorpay pass the provider's field through unchecked, so a malformed
  // delivery reaches here with it empty.
  const where = localSubscriptionWhere(
    ev.applicationId,
    ev.providerSubscriptionId,
    ev.checkoutSessionId,
  );
  if (where === null) {
    ctx.log?.warn(
      { applicationId: ev.applicationId, type: ev.type },
      'subscription status event names no subscription — ignored',
    );
    return;
  }
  // Snapshot the pre-state so the outbound lifecycle event fires only when
  // the LOCAL status actually changes (replays / period-only updates emit
  // nothing).
  const existing = await prisma.subscription.findFirst({
    where,
    select: { id: true, status: true, cancelAt: true },
  });
  const transitioned = Boolean(existing && existing.status !== ev.status);
  // A terminal subscription is not reopened by a later-arriving event. This
  // gates the WRITE, not just the announcement: gating only the announcement is
  // how a stale `ACTIVE` re-delivery used to resurrect a CANCELED subscription,
  // entitlements and all, while the outbox stayed silent about it. See
  // transitionAllowed.
  if (existing && !transitionAllowed(existing.status, ev.status)) {
    ctx.log.warn(
      {
        subscriptionId: existing.id,
        currentStatus: existing.status,
        eventStatus: ev.status,
        providerEventId: ev.providerEventId,
      },
      'billing status event would reopen a terminal subscription — refusing the write',
    );
    return;
  }
  // A cancellation the buyer has already been promised the rest of the period
  // for is NOT shortened by the provider's own cancellation event.
  //
  // This is what makes period-end cancellation possible on a provider that
  // cannot schedule one. PayPal's Subscriptions v1 has a single, immediate
  // cancel (see RealPaypalProvider.cancelSubscription), so asking to cancel at
  // period end terminates the agreement now and PayPal reports it within
  // seconds. Mirroring that report straight onto the local row took the
  // remainder of the period away from the buyer — mid-period, with no refund,
  // moments after the account page had told them "you keep everything you paid
  // for until <date>".
  //
  // The agreement being gone at PayPal is exactly what we wanted: it is what
  // stops the money. What it must not decide is when ENTITLEMENTS end. That
  // date is `cancelAt`, we recorded it ourselves when the cancellation was
  // accepted, and the row is left ACTIVE until `expireIfDue` reaches it.
  //
  // Narrow on purpose:
  //   - only CANCELED. EXPIRED means the subscription ran out its own finite
  //     cycle count — a real ending, not one we scheduled.
  //   - only a `cancelAt` still in the FUTURE, so the provider's event at the
  //     natural end of a scheduled cancellation (Stripe, whose cancellation
  //     really is scheduled, arrives on the day) mirrors normally.
  //   - only from ACTIVE, so it cannot hold a PAST_DUE row open.
  const now = new Date();
  if (
    existing &&
    ev.status === 'CANCELED' &&
    existing.status === 'ACTIVE' &&
    existing.cancelAt !== null &&
    existing.cancelAt > now
  ) {
    ctx.log.info(
      {
        subscriptionId: existing.id,
        cancelAt: existing.cancelAt,
        providerEventId: ev.providerEventId,
      },
      'provider cancelled an agreement we had scheduled — holding the paid period open until cancelAt',
    );
    return;
  }
  // Mirror + outbox row in ONE transaction: the announcement is written with
  // the transition it announces, so a crash between the two cannot leave a
  // CANCELED subscription that nobody was ever told about.
  const deliveryIds = await prisma.$transaction(async (tx) => {
    await tx.subscription.updateMany({
      where,
      data: {
        status: ev.status,
        ...(ev.currentPeriodEnd !== undefined && { currentPeriodEnd: ev.currentPeriodEnd }),
        ...(ev.trialEndsAt !== undefined && { trialEndsAt: ev.trialEndsAt }),
        ...(ev.cancelAt !== undefined && { cancelAt: ev.cancelAt }),
        ...(ev.canceledAt !== undefined && { canceledAt: ev.canceledAt }),
      },
    });
    if (!transitioned || !existing) return [];
    // No outbound event for EXPIRED — a natural end, not a cancellation
    // (consumers read the terminal state off the record).
    if (ev.status === 'ACTIVE') return enqueueSubscriptionEvent(tx, 'subscription.activated', existing.id);
    if (ev.status === 'CANCELED') return enqueueSubscriptionEvent(tx, 'subscription.canceled', existing.id);
    if (ev.status === 'PAST_DUE') return enqueueSubscriptionEvent(tx, 'subscription.past_due', existing.id);
    return [];
  });
  kickDeliveries(deliveryIds);
  if (existing && transitioned) {
    // Dunning case lifecycle mirrors the status transition. A status echo of
    // a failure payment.failed already counted opens no second case
    // (ensureCaseOpen is idempotent per OPEN case) and bumps no counter.
    if (ev.status === 'PAST_DUE') {
      await dunningService.ensureCaseOpen({ subscriptionId: existing.id, log: ctx.log });
    } else if (ev.status === 'ACTIVE') {
      await dunningService.recoverForSubscription(existing.id);
    } else if (ev.status === 'CANCELED' || ev.status === 'EXPIRED') {
      // EXPIRED is terminal too (Razorpay `subscription.completed` — the sub
      // ran its full finite cycle count): close any open case so it doesn't
      // linger.
      await dunningService.closeForCanceledSubscription(existing.id);
    }
  }
}

/**
 * Advance the local billing period by one plan interval — the first-class
 * form of the PayPal-only workaround (PayPal never tells us the new period
 * end, so renewals must advance it locally). Calendar-aware via
 * advanceBillingPeriod so the anchor doesn't drift against the provider's
 * anniversary billing.
 *
 * When the event carries `providerPaymentId` (payment-derived rotation:
 * a renewal sale) the applier owns the renewal gate the bespoke PayPal
 * handler had — translate is pure and cannot query, so the gate cannot
 * live there. Without it the applier advances unconditionally for a known
 * subscription (the original P1 contract; no current module uses that
 * spelling).
 */
export async function applySubscriptionPeriodAdvanced(
  ev: SubscriptionPeriodAdvancedEvent,
  ctx: ApplyContext,
): Promise<void> {
  // An empty id here would match an arbitrary row rather than none: Prisma
  // drops an `undefined` filter, and `null` matches every provider-less
  // subscription. Same hazard as the status mirror above; refuse it first.
  if (!ev.providerSubscriptionId) {
    ctx.log.warn(
      { applicationId: ev.applicationId },
      'subscription.period_advanced without a provider subscription id — ignoring',
    );
    return;
  }
  const localSub = await prisma.subscription.findFirst({
    where: { applicationId: ev.applicationId, providerSubId: ev.providerSubscriptionId },
  });
  if (!localSub) {
    ctx.log.warn(
      { providerSubscriptionId: ev.providerSubscriptionId, applicationId: ev.applicationId },
      'subscription.period_advanced for unknown subscription — ignoring',
    );
    return;
  }
  if (ev.providerPaymentId) {
    // Renewal gate, evaluated BEFORE the funding payment is applied (this
    // event precedes payment.succeeded so the renewal re-provision reads
    // the advanced period):
    //   - the funding sale already recorded → a replayed sale must never
    //     advance the period twice;
    //   - no prior SUCCEEDED payment → this is the FIRST sale, which pays
    //     for the period the activation already provisioned — advancing
    //     would double-grant.
    // Scoped by application — see recordCompletionPayment. A global lookup
    // would see ANOTHER tenant's payment for the same charge id and skip the
    // period advance for a renewal this tenant genuinely just had.
    const alreadyRecorded = await prisma.payment.findUnique({
      where: {
        applicationId_providerPaymentId: {
          applicationId: ev.applicationId,
          providerPaymentId: ev.providerPaymentId,
        },
      },
      select: { id: true },
    });
    if (alreadyRecorded) return;
    const priorSucceeded = await prisma.payment.count({
      where: { subscriptionId: localSub.id, status: 'SUCCEEDED' },
    });
    if (priorSucceeded < 1) return;
  }
  const plan = await prisma.plan.findUnique({ where: { id: localSub.planId } });
  // Extend from the current anchor when it's still in the future (normal
  // renewal), from now when it lapsed (recovery after dunning).
  const base =
    localSub.currentPeriodEnd && localSub.currentPeriodEnd > new Date()
      ? localSub.currentPeriodEnd
      : new Date();
  await prisma.subscription.update({
    where: { id: localSub.id },
    data: { currentPeriodEnd: advanceBillingPeriod(base, plan?.interval) },
  });
}
