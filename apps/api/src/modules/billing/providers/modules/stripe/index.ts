/**
 * Stripe ProviderModule (docs/specs/billing-provider-modules.md, P1).
 *
 * Bundles what used to be spread across stripe.routes.ts (signature
 * verification), stripe.handler.ts (event-type dispatch + status map), and
 * credentials.service.ts (credential shape) into one self-describing
 * descriptor. Every mapping here is a straight port, the CI webhook tests pin
 * the behavior. Outbound provider construction is NOT here: that stayed in
 * providers/index.ts (see the note on `ProviderModule`).
 *
 * Credential JSON keys (`apiKey`, `webhookSecret`, `publishableKey`) match the stored
 * encrypted blobs exactly, zero data migration (see StripeCredentials in
 * credentials.service.ts, the source of truth until P3 derives it from
 * this schema).
 */

import Stripe from 'stripe';
import { CHECKOUT_BROWSER_ORIGINS } from '@rekey.dev/shared-types';
import { RekeyError } from '../../../../../lib/error.js';
import { STRIPE_API_VERSION } from '../../stripe-api-version.js';
import { createStripeClient } from '../../stripe-client.js';
import { detectStripeMode, stripeCredentialSchema, validateStripeCredentials } from './credentials.js';
import { invoiceIdForPaymentIntent } from '../../stripe-invoice-payments.js';
import {
  applicationIdIn,
  chargePaymentRef,
  invoiceSubscriptionId,
  periodEndOf,
  scopedApplicationId,
} from './payload-shapes.js';
import type {
  AppRef,
  CheckoutCompletedEvent,
  DomainBillingEvent,
  LocalSubscriptionStatus,
  ProviderModule,
  RawWebhookReq,
  SubscriptionStatusEvent,
  TranslateCtx,
  VerifyCtx,
  VerifyResult,
} from '../../module-types.js';

// Verifying a webhook signature is offline HMAC, `webhooks.constructEvent`
// makes no network call and never authenticates. The SDK constructor demands
// *a* key regardless, so this client is built with a fixed placeholder. There
// is deliberately no deployment-level Stripe key to configure: the money path
// uses each Application's own BYO credentials, and a deployment-wide key would
// be a cross-tenant trust boundary.
const stripeForVerification = new Stripe('sk_signature_verification_only', {
  apiVersion: STRIPE_API_VERSION,
});

/** The object's own `metadata.applicationId`, runtime-checked. */
function extractApplicationId(obj: { metadata?: unknown } | undefined | null): string | null {
  return applicationIdIn(obj?.metadata);
}

/** Map Stripe subscription status strings to our enum values. */
export function mapStripeSubStatus(s: Stripe.Subscription.Status): LocalSubscriptionStatus {
  switch (s) {
    case 'active':
      return 'ACTIVE';
    // Was folded into ACTIVE, which entitled correctly but made a trial
    // indistinguishable from a paid subscription, no "trial ends in 4 days",
    // no conversion reporting. TRIALING is in ENTITLING_STATUSES, so this
    // changes what we can SEE, not who has access.
    case 'trialing':
      return 'TRIALING';
    case 'past_due':
    case 'unpaid':
      return 'PAST_DUE';
    case 'canceled':
      return 'CANCELED';
    case 'incomplete':
    case 'incomplete_expired':
      return 'EXPIRED';
    case 'paused':
      return 'PENDING';
    default:
      return 'PENDING';
  }
}

/**
 * Pick the lifecycle event type for a mapped status. `status` stays the
 * authoritative field on the event (the appliers key everything off it);
 * EXPIRED buckets under `canceled` (terminal, the sub died before/after
 * activating) and PENDING under `past_due` (billing interrupted, not
 * terminal). See SubscriptionStatusEvent in module-types.ts.
 */
function statusEventType(status: LocalSubscriptionStatus): SubscriptionStatusEvent['type'] {
  switch (status) {
    case 'ACTIVE':
    // A trial starting IS the subscriber gaining access, which is what this
    // event announces, consumers provision on it. There is no
    // `subscription.trial_started` in the catalogue, and minting one is a
    // public-surface decision, not a side effect of adding a status.
    // falls through
    case 'TRIALING':
      return 'subscription.activated';
    case 'CANCELED':
    case 'EXPIRED':
      return 'subscription.canceled';
    case 'PAST_DUE':
    case 'PENDING':
      return 'subscription.past_due';
  }
}

function resolveApplication(req: RawWebhookReq): AppRef {
  // The historical (and only registered-with-Stripe) endpoint is per-app
  // slug-scoped: the slug names whose webhook secret verifies the request,
  // which is what makes it trustworthy. Keep that as the primary model.
  if (req.params.slug) return { slug: req.params.slug };
  // Slug-less generic-route fallback: the one payload field the spec allows
  // reading pre-verify. Verification with THAT app's secret then proves the
  // claim, a forged payload naming app X still needs X's signing secret.
  const event = req.payload as { data?: { object?: unknown } } | null;
  const applicationId = scopedApplicationId(event?.data?.object);
  if (applicationId) return { applicationId };
  // No slug and no metadata → nothing to scope credentials by. 401, an
  // unverifiable request is unauthenticated.
  throw new RekeyError({
    statusCode: 401,
    code: 'WEBHOOK_APPLICATION_UNRESOLVED',
    message: 'Stripe webhook carries no applicationId metadata and the URL has no app slug.',
    fix: 'Point Stripe at the per-application endpoint (…/webhooks/billing/stripe/<appSlug>).',
  });
}

async function verify(req: RawWebhookReq, creds: Record<string, string>, _ctx: VerifyCtx): Promise<VerifyResult> {
  const sig = req.headers['stripe-signature'];
  if (typeof sig !== 'string') {
    return {
      ok: false,
      code: 'WEBHOOK_SIGNATURE_MISSING',
      message: 'Missing stripe-signature header.',
      fix: "Stripe sets this automatically; for tests use stripe.webhooks.generateTestHeaderString().",
    };
  }
  try {
    // Offline HMAC over the exact raw bytes. constructEvent also parses, but
    // the pipeline already holds the parsed body, verification is the only
    // output we need here.
    stripeForVerification.webhooks.constructEvent(req.rawBody, sig, creds.webhookSecret ?? '');
  } catch {
    return {
      ok: false,
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Stripe webhook signature is invalid.',
      fix: 'Check the webhook secret matches what Stripe shows for this endpoint.',
    };
  }
  return { ok: true };
}

/**
 * The charge a ONE-TIME (`mode: 'payment'`) checkout session settled, in the
 * shape `CheckoutCompletedEvent.payment` takes, or null when this completion
 * carries no charge of its own.
 *
 * Why this rides on the completion rather than on its own event type: a
 * `mode: 'payment'` session produces no invoice, so none of the invoice events
 * we subscribe to ever fire for it and one-time revenue had no `Payment` row
 * anywhere in Rekey. The obvious repair, subscribing `payment_intent.succeeded`,
 * is worse than it looks: that event ALSO fires for every invoice payment on
 * every subscription (so it would double-count against `invoice.paid` under a
 * different provider id), and its payload has no checkout-session or
 * subscription reference to match the local row by. The session has all three:
 * the payment intent, the amount actually charged after the coupon, and a
 * `payment_status` that says whether money really moved.
 *
 * `mode: 'subscription'` sessions return null on purpose, their money is
 * `invoice.paid`'s to record, and recording it twice under two provider ids is
 * exactly the double-count this avoids.
 */
function oneTimeCharge(
  session: Stripe.Checkout.Session,
): { payment: NonNullable<CheckoutCompletedEvent['payment']> } | null {
  if (session.mode !== 'payment') return null;
  // `unpaid` happens on delayed-notification methods; the money is not ours
  // until `checkout.session.async_payment_succeeded`, which we do not consume.
  // `no_payment_required` is a zero-value session, which checkout-discount.ts
  // refuses to create in the first place.
  if (session.payment_status !== 'paid') return null;
  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id ?? null;
  // Fall back to the session id when the intent is not expanded: the point is
  // a stable, unique provider reference for the idempotency index, and the
  // session id is one. Losing the payment row entirely is the worse outcome.
  const providerPaymentId = paymentIntentId ?? session.id;
  return {
    payment: {
      providerPaymentId,
      // `amount_total` is what the buyer was charged, net of the ad-hoc
      // coupon, which is the number that has to appear in revenue.
      amount: session.amount_total,
      currency: session.currency ?? null,
      description: null,
    },
  };
}

/** How long a first invoice waits for its checkout before it is filed as unapplied. */
const DEFER_FIRST_INVOICE_SECONDS = 24 * 60 * 60;

function isRecentEvent(createdSeconds: unknown): boolean {
  return (
    typeof createdSeconds === 'number' && Date.now() / 1000 - createdSeconds < DEFER_FIRST_INVOICE_SECONDS
  );
}

/**
 * Translate the Stripe event types Rekey consumes into normalized domain
 * events. Everything else → null (logged + acked upstream). Application
 * scoping is payload-metadata based: missing metadata means "cannot route",
 * warn + no events, never guess (see webhooks/AGENTS.md). The one exception
 * is `charge.refunded`, whose renewal charges carry no metadata and fall back
 * to the Application whose secret verified the request.
 */
async function translate(payload: unknown, ctx: TranslateCtx): Promise<DomainBillingEvent[] | null> {
  const event = payload as Stripe.Event;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session;
      const applicationId = extractApplicationId(session);
      if (!applicationId) {
        ctx.log.warn(
          { sessionId: session.id },
          `${event.type} without applicationId metadata, cannot route`,
        );
        return [];
      }
      // A delayed payment method (bank debit, voucher) completes the session
      // before any money moves. Activating here would provision a buyer whose
      // payment can still fail; `async_payment_succeeded` completes it instead.
      if (session.payment_status === 'unpaid') {
        ctx.log.info(
          { sessionId: session.id },
          'checkout completed unpaid (delayed payment method), waiting for async_payment_succeeded',
        );
        return [];
      }
      return [
        {
          type: 'checkout.completed',
          providerEventId: event.id,
          applicationId,
          checkoutSessionId: session.id,
          providerSubscriptionId:
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription?.id ?? null,
          ...(oneTimeCharge(session) ?? {}),
          raw: payload,
        },
      ];
    }
    case 'checkout.session.async_payment_failed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const applicationId = extractApplicationId(session);
      if (!applicationId) {
        ctx.log.warn({ sessionId: session.id }, `${event.type} without applicationId metadata, cannot route`);
        return [];
      }
      return [
        {
          type: 'checkout.payment_failed',
          providerEventId: event.id,
          applicationId,
          checkoutSessionId: session.id,
          providerSubscriptionId: typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null),
          raw: payload,
        },
      ];
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const applicationId = extractApplicationId(sub);
      if (!applicationId) {
        ctx.log.warn({ subId: sub.id }, 'subscription.updated without applicationId metadata');
        return [];
      }
      const status = mapStripeSubStatus(sub.status);
      return [
        {
          type: statusEventType(status),
          providerEventId: event.id,
          applicationId,
          providerSubscriptionId: sub.id,
          status,
          // Absolute mirror, null clears, matching the pre-module handler.
          currentPeriodEnd: periodEndOf(sub),
          trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
          cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000) : null,
          canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
          raw: payload,
        },
      ];
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const applicationId = extractApplicationId(sub);
      if (!applicationId) {
        ctx.log.warn({ subId: sub.id }, 'subscription.deleted without applicationId metadata');
        return [];
      }
      return [
        {
          type: 'subscription.canceled',
          providerEventId: event.id,
          applicationId,
          providerSubscriptionId: sub.id,
          status: 'CANCELED',
          // Only canceledAt is written on delete (period fields untouched);
          // fall back to "now" when Stripe omits the timestamp.
          canceledAt: new Date(sub.canceled_at ? sub.canceled_at * 1000 : Date.now()),
          raw: payload,
        },
      ];
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      const applicationId = scopedApplicationId(invoice);
      if (!applicationId) {
        ctx.log.warn({ invoiceId: invoice.id }, 'invoice.paid without applicationId metadata');
        return [];
      }
      const firstPeriod = invoice.billing_reason === 'subscription_create';
      if (firstPeriod && invoice.amount_paid === 0) {
        // A trial's first invoice: nothing was charged, checkout already
        // provisioned the period, and the status mirror owns what the row is.
        // A $0 RENEWAL is not skipped: it is the only thing that refills
        // credits and extends a TIMED licence for the new period.
        ctx.log.info({ invoiceId: invoice.id }, 'first invoice charged nothing, no payment recorded');
        return [];
      }
      return [
        {
          type: 'payment.succeeded',
          providerEventId: event.id,
          applicationId,
          providerPaymentId: invoice.id,
          providerSubscriptionId: invoiceSubscriptionId(invoice),
          amount: invoice.amount_paid,
          currency: invoice.currency ?? null,
          description: invoice.description ?? null,
          // The FIRST invoice (billing_reason: subscription_create) pays for
          // the period checkout already provisioned, the applier anchors it
          // 'initial' to prevent a double grant.
          firstPeriod,
          // Nothing orders this before checkout.session.completed, which is
          // what links the subscription. Filing it as unapplied in that gap
          // would email the operator about a payment that is about to apply.
          // Only while the event is young: a checkout that never reaches
          // Rekey must still end up in front of the operator.
          deferUntilLinked: firstPeriod && isRecentEvent(event.created),
          raw: payload,
        },
      ];
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const applicationId = scopedApplicationId(invoice);
      if (!applicationId) {
        ctx.log.warn(
          { invoiceId: invoice.id },
          'invoice.payment_failed without applicationId metadata',
        );
        return [];
      }
      return [
        {
          type: 'payment.failed',
          providerEventId: event.id,
          applicationId,
          providerPaymentId: invoice.id,
          providerSubscriptionId: invoiceSubscriptionId(invoice),
          amount: invoice.amount_due,
          currency: invoice.currency ?? null,
          description: invoice.description ?? null,
          raw: payload,
        },
      ];
    }
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      // A renewal's charge is created by its invoice and carries none of our
      // metadata, so the route's Application is the fallback. The slug
      // selected the secret that verified this body, which is what makes it
      // trustworthy.
      const applicationId = extractApplicationId(charge) ?? ctx.applicationId;
      if (!applicationId) {
        ctx.log.warn({ chargeId: charge.id }, 'charge.refunded without applicationId, cannot route');
        return [];
      }
      return [
        {
          type: 'payment.refunded',
          providerEventId: event.id,
          applicationId,
          providerPaymentId: await chargePaymentId(charge, ctx),
          providerSubscriptionId: null,
          amount: charge.amount_refunded,
          refundedTotal: charge.amount_refunded,
          currency: charge.currency ?? null,
          description: null,
          raw: payload,
        },
      ];
    }
    default:
      return null;
  }
}

/**
 * The id a refunded charge's Payment row was recorded under: the invoice for
 * a subscription charge (`invoice.paid`), the payment intent for a one-time
 * checkout (`oneTimeCharge`), the charge itself when neither is present.
 *
 * A basil-or-later charge no longer names its invoice. One carrying our
 * metadata is a one-time checkout's (its payment intent's metadata is copied
 * onto the charge), recorded under the intent, so no lookup. Otherwise the
 * invoice is asked of Stripe with the credentials that verified this event. A
 * failed or impossible lookup throws, which answers 500 and Stripe retries;
 * recording the refund against the payment intent instead would match no
 * renewal and lose it.
 */
async function chargePaymentId(charge: Stripe.Charge, ctx: TranslateCtx): Promise<string> {
  const ref = chargePaymentRef(charge);
  if ('recorded' in ref) return ref.recorded;
  if (extractApplicationId(charge)) return ref.lookupByIntent;
  const apiKey = ctx.credentials?.apiKey;
  if (!apiKey) {
    throw new Error(
      `Stripe charge ${charge.id} names no invoice, and finding it needs the Application's Stripe secret key, which this translation was not given.`,
    );
  }
  const invoiceId = await invoiceIdForPaymentIntent(createStripeClient(apiKey), ref.lookupByIntent);
  return invoiceId ?? ref.lookupByIntent;
}

export const stripeModule: ProviderModule = {
  name: 'stripe',
  display: {
    label: 'Stripe',
    docsUrl: 'https://docs.stripe.com/keys',
    // Historical geo-routing default: Stripe is the global fallback
    // (pickProvider treats an empty country list as "any country").
    defaultCountries: [],
    priority: 100,
  },
  capabilities: {
    checkout: true,
    oneTime: true,
    captureStep: false,
    autoWebhookRegister: true,
    periodRotationEvents: true,
    onlineVerify: false,
    // `subscription_data.trial_period_days` on the Checkout Session. Stripe
    // runs the trial, charges when it ends, and reports `trialing` until then.
    trials: true,
    // Both hosted flows take `discounts: [{ coupon }]` on the Checkout
    // Session, so an ad-hoc Coupon minted per checkout covers each. On a
    // subscription the coupon is created `duration: 'once'`, which is what a
    // single recorded redemption actually buys, see stripe-real.ts.
    discounts: { oneTime: true, recurring: true },
    // Stripe documents no deadline on refunds, the API will take an old
    // charge, and what actually stops one is the card network or the buyer's
    // bank rather than Stripe. `null` says that honestly instead of inventing
    // a limit to look symmetrical with the other two.
    refunds: { partial: true, windowDays: null },
    // The same Checkout Session in `ui_mode: 'elements'`, with the Payment
    // Element on the Rekey page. Needs the optional `publishableKey`, which
    // readiness check 6 asks for.
    embeddedCheckout: { recurring: true, oneTime: true },
  },
  browser: CHECKOUT_BROWSER_ORIGINS.stripe!,
  // Stripe checkout takes a `price` id and nothing else, so a plan with no
  // stored price cannot be bought and never will be until someone registers
  // it. `createCheckoutSession` already refuses with the same repair; saying
  // it here means the operator hears it while looking at the plan list rather
  // than from the first buyer who tried to pay.
  planCheckoutBlocker(plan) {
    if (plan.registrationStatus === 'FAILED') {
      return {
        code: 'PLAN_REGISTRATION_FAILED',
        message:
          plan.registrationError ??
          `Stripe refused to register plan "${plan.slug}", so it has no price behind it.`,
        fix: `Fix whatever Stripe objected to, then POST /api/v1/tenant/applications/${plan.applicationId}/plans/${plan.slug}/register to retry.`,
      };
    }
    const priceId = (plan.metadata as { stripe?: { priceId?: string } } | null)?.stripe?.priceId;
    if (priceId) return null;
    return {
      code: 'PLAN_NOT_REGISTERED',
      message: `Plan "${plan.slug}" has no Stripe price, so a buyer sent to Stripe checkout is refused.`,
      fix: `Plans register with Stripe when they are created, so a plan created before these credentials existed was never registered. Repair it in place: POST /api/v1/tenant/applications/${plan.applicationId}/plans/${plan.slug}/register`,
    };
  },
  credentialSchema: stripeCredentialSchema,
  validateCredentials: validateStripeCredentials,
  detectMode: detectStripeMode,
  webhook: {
    resolveApplication,
    verify,
    extractEventId(payload: unknown): string {
      return (payload as { id?: string }).id as string;
    },
    extractEventType(payload: unknown): string {
      return (payload as { type?: string }).type ?? 'unknown';
    },
    eventMode(payload: unknown): 'test' | 'live' | null {
      const livemode = (payload as { livemode?: unknown }).livemode;
      if (livemode === true) return 'live';
      if (livemode === false) return 'test';
      return null;
    },
    translate,
  },
};

export default stripeModule;
