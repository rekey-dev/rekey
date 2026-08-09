/**
 * PayPal ProviderModule (docs/specs/billing-provider-modules.md, P2).
 *
 * Bundles what used to be spread across paypal.routes.ts (ONLINE signature
 * verification via /v1/notifications/verify-webhook-signature) and
 * paypal.handler.ts (the 7-event dispatch switch, Subscriptions v1 +
 * Orders v2) into one descriptor. Every mapping is a straight port — CI's
 * paypal-webhook + dunning + outbound-events suites pin the behavior
 * through the legacy alias URL.
 *
 * The test-skip for the online verify lives in the PIPELINE, keyed off
 * `capabilities.onlineVerify` — never here (a module must not be able to
 * skip its own verification).
 *
 * PayPal has no native period-rotation event
 * (capabilities.periodRotationEvents: false): a renewal sale translates to
 * `subscription.period_advanced` (ordered BEFORE the payment event so the
 * renewal re-provision anchors on the advanced period), with the
 * applier-side renewal gate keyed on the sale's payment id.
 *
 * Credential JSON keys (`clientId`, `clientSecret`, `webhookId`) match the
 * stored encrypted blobs exactly — zero data migration (see
 * PaypalCredentials in credentials.service.ts).
 */

import { RekeyError } from '../../../../../lib/error.js';
import { paypalScale } from '../../paypal-money.js';
import { verifyPaypalWebhook } from '../../paypal.js';
import type { PaypalCredentials } from '../../../credentials.service.js';
import type {
  AppRef,
  DomainBillingEvent,
  ProviderModule,
  RawWebhookReq,
  TranslateCtx,
  VerifyCtx,
  VerifyResult,
} from '../../module-types.js';
import type { FastifyBaseLogger } from 'fastify';

/** PayPal event envelope (only the fields we read). */
interface PaypalEventPayload {
  id?: string;
  event_type?: string;
  resource?: {
    id?: string;
    custom_id?: string;
    billing_agreement_id?: string;
    status?: string;
    // PAYMENT.SALE.* uses { amount: { total, currency } }; subscription
    // resources omit amount.
    amount?: { total?: string; value?: string; currency_code?: string; currency?: string };
    // PAYMENT.CAPTURE.* (Orders v2) is the only place the originating order id
    // appears — the capture resource's own `id` is the CAPTURE, not the order.
    supplementary_data?: { related_ids?: { order_id?: string } };
    // Subscription resources carry the schedule. `next_billing_time` is the
    // one field that says when the period the buyer has paid for runs out.
    billing_info?: { next_billing_time?: string };
  };
}

/**
 * PayPal's own answer to "when does the period they have paid for end?".
 *
 * `billing_info.next_billing_time` is an ISO-8601 instant on the subscription
 * resource — the moment PayPal will next take money. It is therefore exactly
 * the anchor `cancelEffect` needs, and better than the locally computed
 * one: `advanceBillingPeriod` approximates the anniversary from our own plan
 * interval and can drift against PayPal's real schedule.
 *
 * Reading it fixes a defect that made the whole period-end feature a no-op on
 * PayPal's most common case. Nothing wrote `currentPeriodEnd` for a PayPal
 * subscription until its SECOND charge — `subscription.period_advanced`
 * refuses to advance while no prior succeeded payment exists, which is correct
 * (the first sale pays for the period activation already granted) but left the
 * column NULL for the whole of the first period. `cancelEffect` requires
 * it to be non-null, so every first-period cancellation was immediate: the
 * buyer lost the time they had just paid for, which is the precise harm #336
 * was opened to remove.
 *
 * Returns undefined for anything unparseable, which leaves the column
 * untouched. That degrades to the old behaviour — an honest immediate
 * cancellation, correctly described, rather than a period end invented from a
 * bad string.
 */
function periodEndFromBillingInfo(
  resource: PaypalEventPayload['resource'],
  log: FastifyBaseLogger,
  context: Record<string, unknown>,
): Date | undefined {
  const raw = resource?.billing_info?.next_billing_time;
  if (typeof raw !== 'string') return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    log.warn({ ...context, nextBillingTime: raw }, 'paypal next_billing_time unparseable — leaving period end untouched');
    return undefined;
  }
  return parsed;
}

/** Mirror of the shared applier cap — 100,000,000.00 in minor units. */
const MAX_PAYMENT_AMOUNT = 10_000_000_000;

/**
 * Parse a PayPal money string ("12.34") in major units into the smallest
 * currency unit (cents). Returns null on anything non-finite / out of
 * range — the amount-shape gate has to live here because the shared
 * applier's safeAmount expects integer minor units, and "unusable amount"
 * must skip the whole event (the bespoke handler recorded nothing).
 */
function paypalAmountToMinor(
  value: string | undefined,
  currency: string | undefined,
  log: FastifyBaseLogger,
  context: Record<string, unknown>,
): number | null {
  if (value == null) return null;
  const major = Number(value);
  if (!Number.isFinite(major) || major < 0) {
    log.warn({ ...context, value }, 'paypal amount non-finite/negative — dropping');
    return null;
  }
  const minor = Math.round(major * paypalScale(currency));
  if (minor > MAX_PAYMENT_AMOUNT) {
    log.error({ ...context, value, max: MAX_PAYMENT_AMOUNT }, 'paypal amount exceeds max — refusing');
    return null;
  }
  return minor;
}

/**
 * Cross-check the `${appId}:${euId}` custom_id (set by
 * RealPaypalProvider.createCheckoutSession) when PayPal echoes it. Primary
 * scoping is the per-app URL slug; this is defense-in-depth.
 */
function applicationIdMatches(
  resource: PaypalEventPayload['resource'],
  applicationId: string,
): boolean {
  const custom = resource?.custom_id;
  if (!custom) return true; // PayPal didn't echo it (e.g. PAYMENT.SALE) — trust the URL scope.
  const [appId] = custom.split(':', 1);
  return appId === applicationId;
}

function resolveApplication(req: RawWebhookReq): AppRef {
  // Shape gate first — the legacy route 400'd an unrecognisable body before
  // resolving anything, and resolveApplication is the only pre-verify step.
  const p = req.payload as PaypalEventPayload | null;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.event_type !== 'string') {
    throw new RekeyError({
      statusCode: 400,
      code: 'WEBHOOK_PAYLOAD_INVALID',
      message: 'PayPal webhook body is not a recognisable event.',
      fix: 'Expect a JSON object with `id` and `event_type`.',
    });
  }
  // Slug-scoped only: PayPal verification requires the per-app webhook id,
  // so the slug is mandatory.
  if (req.params.slug) return { slug: req.params.slug };
  throw new RekeyError({
    statusCode: 401,
    code: 'WEBHOOK_APPLICATION_UNRESOLVED',
    message: 'PayPal webhook URL carries no application slug.',
    fix: 'Point PayPal at the per-application endpoint (…/webhooks/billing/paypal/<appSlug>).',
  });
}

async function verify(
  req: RawWebhookReq,
  creds: Record<string, string>,
  ctx: VerifyCtx,
): Promise<VerifyResult> {
  // ONLINE verification: transmission headers + parsed event + our webhook
  // id posted to PayPal's verify-webhook-signature API (sandbox vs live
  // base URL from the credential row's mode). Fail-closed on any network
  // error / non-SUCCESS — but the two are reported differently.
  const outcome = await verifyPaypalWebhook({
    creds: creds as unknown as PaypalCredentials,
    mode: ctx.mode,
    headers: req.headers,
    event: req.payload,
  });
  if (outcome.ok) return { ok: true };
  if (outcome.reason === 'unreachable') {
    // PayPal did not answer within the request-path budget. Nothing is
    // processed (still fail-closed), but 503 is the honest status: telling
    // PayPal its signature was invalid, when the fault is that we could not
    // reach PayPal to ask, is how an endpoint gets disabled for an outage.
    return {
      ok: false,
      statusCode: 503,
      code: 'WEBHOOK_VERIFICATION_UNAVAILABLE',
      message: 'PayPal did not answer the signature-verification call in time.',
      fix: 'Transient — PayPal will retry the webhook. If it persists, check PayPal status and this deployment\'s egress to api-m.paypal.com.',
    };
  }
  return {
    ok: false,
    code: 'WEBHOOK_SIGNATURE_INVALID',
    message: 'PayPal webhook signature verification failed.',
    fix: 'Check the webhook id matches what PayPal shows for this endpoint, and that the transmission headers are intact.',
  };
}

/**
 * Port of the paypal.handler.ts dispatch switch — the same 7 handled event
 * types translated to normalized domain events, plus
 * `PAYMENT.CAPTURE.COMPLETED` (registered with PayPal from the start, never
 * handled). Everything else → null (logged + acked upstream).
 */
function translate(payload: unknown, ctx: TranslateCtx): DomainBillingEvent[] | null {
  const event = payload as PaypalEventPayload;
  const applicationId = ctx.applicationId;
  if (!applicationId) {
    ctx.log.error({ eventType: event.event_type }, 'paypal translate without a route-resolved application');
    return [];
  }
  const providerEventId =
    typeof event.id === 'string' ? event.id : ctx.providerEventId ?? 'unknown';
  const resource = event.resource;

  switch (event.event_type) {
    // PENDING → ACTIVE, persist providerSubId (the local row was created
    // with metadata.checkoutSessionId == PayPal sub id). firstPeriod: false
    // preserves the bespoke provision anchor (currentPeriodEnd ?? 'initial'
    // — identical for a fresh activation, current-period on a
    // suspension→reactivation). The applier also recovers any open dunning
    // case on the actual transition.
    case 'BILLING.SUBSCRIPTION.ACTIVATED': {
      const subId = resource?.id;
      if (!subId || !applicationIdMatches(resource, applicationId)) {
        ctx.log.warn({ eventId: providerEventId }, 'subscription.activated: missing id or app mismatch');
        return [];
      }
      const currentPeriodEnd = periodEndFromBillingInfo(resource, ctx.log, {
        eventId: providerEventId,
      });
      return [
        {
          type: 'checkout.completed',
          providerEventId,
          applicationId,
          checkoutSessionId: subId,
          providerSubscriptionId: subId,
          firstPeriod: false,
          // Present from the activation onwards, so a first-period
          // cancellation can be scheduled instead of silently terminating.
          ...(currentPeriodEnd && { currentPeriodEnd }),
          raw: payload,
        },
      ];
    }
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED': {
      const subId = resource?.id;
      if (!subId) return [];
      return [
        {
          type: 'subscription.canceled',
          providerEventId,
          applicationId,
          providerSubscriptionId: subId,
          status: 'CANCELED',
          canceledAt: new Date(),
          raw: payload,
        },
      ];
    }
    // SUSPENDED is PayPal's dunning state, not a hard cancel — PAST_DUE so
    // a transient failure doesn't kill the subscription. The mirror applier
    // opens the case via ensureCaseOpen (a status signal, not a counted
    // payment failure).
    case 'BILLING.SUBSCRIPTION.SUSPENDED': {
      const subId = resource?.id;
      if (!subId) return [];
      return [
        {
          type: 'subscription.past_due',
          providerEventId,
          applicationId,
          providerSubscriptionId: subId,
          status: 'PAST_DUE',
          raw: payload,
        },
      ];
    }
    // One-time purchase via Orders v2: the buyer approved; the applier
    // captures (capabilities.captureStep) then fulfills.
    case 'CHECKOUT.ORDER.APPROVED': {
      const orderId = resource?.id;
      if (!orderId) {
        ctx.log.warn({ eventId: providerEventId }, 'order.approved: missing order id');
        return [];
      }
      return [
        {
          type: 'checkout.approved',
          providerEventId,
          applicationId,
          checkoutSessionId: orderId,
          provider: 'paypal',
          raw: payload,
        },
      ];
    }
    // Recurring sale: record the SUCCEEDED Payment, ensure ACTIVE, recover
    // dunning, re-provision. PayPal never rotates currentPeriodEnd itself,
    // so a genuine RENEWAL sale first advances the local period —
    // period_advanced is ordered BEFORE payment.succeeded so the
    // re-provision anchors on the NEW period, and its applier-side gate
    // (sale not yet recorded + a prior succeeded payment exists) reproduces
    // the bespoke "2nd+ charge only, never on replay" rule (#72/#73).
    case 'PAYMENT.SALE.COMPLETED': {
      const amount = paypalAmountToMinor(
        resource?.amount?.total ?? resource?.amount?.value,
        resource?.amount?.currency_code ?? resource?.amount?.currency,
        ctx.log,
        { eventId: providerEventId },
      );
      if (amount === null) {
        ctx.log.warn({ eventId: providerEventId }, 'sale.completed: no usable amount — skipping payment row');
        return [];
      }
      const currency = (
        resource?.amount?.currency_code ??
        resource?.amount?.currency ??
        'USD'
      ).toUpperCase();
      const agreementId = resource?.billing_agreement_id ?? null;
      const providerPaymentId = resource?.id ?? providerEventId;
      const events: DomainBillingEvent[] = [];
      if (agreementId) {
        events.push({
          type: 'subscription.period_advanced',
          providerEventId,
          applicationId,
          providerSubscriptionId: agreementId,
          providerPaymentId,
          raw: payload,
        });
      }
      events.push({
        type: 'payment.succeeded',
        providerEventId,
        applicationId,
        providerPaymentId,
        providerSubscriptionId: agreementId,
        amount,
        currency,
        description: null,
        // Never 'initial'-pinned: the bespoke handler always anchored on
        // currentPeriodEnd ?? 'initial', which the un-advanced first sale
        // resolves to 'initial' anyway (colliding with the activation
        // grant), and a renewal to the just-advanced period.
        firstPeriod: false,
        raw: payload,
      });
      return events;
    }
    // The money leg of a ONE-TIME purchase (Orders v2). It has been registered
    // with PayPal since webhook auto-configuration existed but had no case
    // here, so it fell to `default: null` and one-off revenue produced no
    // `Payment` row at all — the order was captured and fulfilled by
    // CHECKOUT.ORDER.APPROVED above and then simply never appeared in
    // anybody's books.
    //
    // Matched to the local row by the ORDER id out of `supplementary_data`,
    // not by the capture id: `metadata.checkoutSessionId` holds the order.
    // `firstPeriod: true` pins the re-provision to the 'initial' anchor so it
    // collides with the grant the approval already made — a one-off purchase
    // has no periods to refill.
    case 'PAYMENT.CAPTURE.COMPLETED': {
      const amount = paypalAmountToMinor(
        resource?.amount?.value ?? resource?.amount?.total,
        resource?.amount?.currency_code ?? resource?.amount?.currency,
        ctx.log,
        { eventId: providerEventId },
      );
      if (amount === null) {
        ctx.log.warn({ eventId: providerEventId }, 'capture.completed: no usable amount — skipping payment row');
        return [];
      }
      if (!applicationIdMatches(resource, applicationId)) {
        ctx.log.warn({ eventId: providerEventId }, 'capture.completed: app mismatch on custom_id');
        return [];
      }
      const orderId = resource?.supplementary_data?.related_ids?.order_id;
      const currency = (
        resource?.amount?.currency_code ??
        resource?.amount?.currency ??
        'USD'
      ).toUpperCase();
      return [
        {
          type: 'payment.succeeded',
          providerEventId,
          applicationId,
          providerPaymentId: resource?.id ?? providerEventId,
          // A capture belongs to an order, never to a billing agreement —
          // recurring money arrives as PAYMENT.SALE.COMPLETED above.
          providerSubscriptionId: null,
          ...(orderId !== undefined && { checkoutSessionId: orderId }),
          amount,
          currency,
          description: null,
          firstPeriod: true,
          raw: payload,
        },
      ];
    }
    case 'PAYMENT.SALE.DENIED':
    case 'PAYMENT.SALE.REVERSED': {
      const amount =
        paypalAmountToMinor(
          resource?.amount?.total ?? resource?.amount?.value,
          resource?.amount?.currency_code ?? resource?.amount?.currency,
          ctx.log,
          { eventId: providerEventId },
        ) ?? 0;
      const currency = (
        resource?.amount?.currency_code ??
        resource?.amount?.currency ??
        'USD'
      ).toUpperCase();
      return [
        {
          type: 'payment.failed',
          providerEventId,
          applicationId,
          providerPaymentId: resource?.id ?? providerEventId,
          providerSubscriptionId: resource?.billing_agreement_id ?? null,
          amount,
          currency,
          description: null,
          raw: payload,
        },
      ];
    }
    default:
      return null;
  }
}

export const paypalModule: ProviderModule = {
  name: 'paypal',
  display: {
    label: 'PayPal',
    docsUrl: 'https://developer.paypal.com/api/rest/webhooks/',
    // Suggested only. Global (no country restriction) at a higher `priority`
    // number than Stripe, so if both are saved with these defaults Stripe wins —
    // but nothing applies them automatically; `pickProvider` reads the row.
    defaultCountries: [],
    priority: 110,
  },
  capabilities: {
    oneTime: true,
    // Orders v2 doesn't auto-capture — CHECKOUT.ORDER.APPROVED →
    // checkout.approved → applier captures via captureOneTime.
    captureStep: true,
    autoWebhookRegister: true,
    // No native period-rotation event; renewals advance the local period
    // via subscription.period_advanced.
    periodRotationEvents: false,
    // Signature verification calls PayPal's API — the pipeline's
    // centralized gate skips it under NODE_ENV=test (never in production).
    onlineVerify: true,
    // Orders v2 takes a real discount line (`amount.breakdown.discount`), so
    // one-off purchases discount cleanly. Subscriptions v1 does not: the only
    // per-subscription price control is the inline `plan` override at create
    // time, and that can only restate the pricing_scheme of a cycle the plan
    // already declares. Ours declare one REGULAR cycle with `total_cycles: 0`,
    // so "take 20% off the first month" comes out as "take 20% off every
    // month, forever" — against a single recorded redemption and a single
    // `discountAmount`. Refusing the coupon is the honest answer; charging a
    // permanently wrong price is just a different lie from charging full price.
    // Doing this properly needs an intro TRIAL cycle minted onto the plan,
    // which is a plan-registration feature, not a checkout one.
    discounts: { oneTime: true, recurring: false },
  },
  credentialSchema: [
    {
      key: 'clientId',
      label: 'Client ID',
      secret: false,
      help: 'PayPal Developer Dashboard → Apps & Credentials.',
    },
    {
      key: 'clientSecret',
      label: 'Client secret',
      secret: true,
      help: 'PayPal Developer Dashboard → Apps & Credentials.',
    },
    {
      key: 'webhookId',
      label: 'Webhook ID',
      secret: false,
      optional: true,
      help: 'Leave blank and auto-configure the webhook, or paste the id from PayPal → Webhooks.',
      webhookRole: 'id',
    },
  ],
  webhook: {
    resolveApplication,
    verify,
    extractEventId(payload: unknown): string {
      return (payload as PaypalEventPayload).id as string;
    },
    extractEventType(payload: unknown): string {
      return (payload as PaypalEventPayload).event_type ?? 'unknown';
    },
    translate,
  },
};

export default paypalModule;
