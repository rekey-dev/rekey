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
import { PaypalStubProvider, RealPaypalProvider, verifyPaypalWebhook } from '../../paypal.js';
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
  };
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
  log: FastifyBaseLogger,
  context: Record<string, unknown>,
): number | null {
  if (value == null) return null;
  const major = Number(value);
  if (!Number.isFinite(major) || major < 0) {
    log.warn({ ...context, value }, 'paypal amount non-finite/negative — dropping');
    return null;
  }
  const minor = Math.round(major * 100);
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
  // error / non-SUCCESS.
  const ok = await verifyPaypalWebhook({
    creds: creds as unknown as PaypalCredentials,
    mode: ctx.mode,
    headers: req.headers,
    event: req.payload,
  });
  if (!ok) {
    return {
      ok: false,
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'PayPal webhook signature verification failed.',
      fix: 'Check the webhook id matches what PayPal shows for this endpoint, and that the transmission headers are intact.',
    };
  }
  return { ok: true };
}

/**
 * Port of the paypal.handler.ts dispatch switch — the same 7 handled event
 * types translated to normalized domain events. Everything else → null
 * (logged + acked upstream).
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
      return [
        {
          type: 'checkout.completed',
          providerEventId,
          applicationId,
          checkoutSessionId: subId,
          providerSubscriptionId: subId,
          firstPeriod: false,
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
    case 'PAYMENT.SALE.DENIED':
    case 'PAYMENT.SALE.REVERSED': {
      const amount =
        paypalAmountToMinor(resource?.amount?.total ?? resource?.amount?.value, ctx.log, {
          eventId: providerEventId,
        }) ?? 0;
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
    // Global fallback alongside Stripe; lower preference (see pickProvider's
    // ambient default: stripe if available, else paypal).
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
    // centralized gate skips it under NODE_ENV=test /
    // RELIPAY_BILLING_FORCE_STUB (never in production).
    onlineVerify: true,
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
  createProvider(creds, ctx) {
    // Same selection the factory (providers/index.ts) applies for the
    // creds-present case; mode picks the sandbox vs live base URL.
    if (process.env.NODE_ENV === 'test' || process.env.RELIPAY_BILLING_FORCE_STUB === 'true') {
      return new PaypalStubProvider();
    }
    return new RealPaypalProvider(creds as unknown as PaypalCredentials, ctx.mode);
  },
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
