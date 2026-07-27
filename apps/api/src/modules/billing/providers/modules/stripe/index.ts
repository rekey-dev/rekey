/**
 * Stripe ProviderModule (docs/specs/billing-provider-modules.md, P1).
 *
 * Bundles what used to be spread across stripe.routes.ts (signature
 * verification), stripe.handler.ts (event-type dispatch + status map), the
 * provider factory (stub-vs-real selection), and credentials.service.ts
 * (credential shape) into one self-describing descriptor. Every mapping
 * here is a straight port — the CI webhook tests pin the behavior.
 *
 * Credential JSON keys (`apiKey`, `webhookSecret`) match the stored
 * encrypted blobs exactly — zero data migration (see StripeCredentials in
 * credentials.service.ts, the source of truth until P3 derives it from
 * this schema).
 */

import Stripe from 'stripe';
import { env } from '../../../../../config/env.js';
import { RekeyError } from '../../../../../lib/error.js';
import { StripeStubProvider } from '../../stripe.js';
import { RealStripeProvider } from '../../stripe-real.js';
import type { StripeCredentials } from '../../../credentials.service.js';
import type {
  AppRef,
  DomainBillingEvent,
  LocalSubscriptionStatus,
  ProviderModule,
  RawWebhookReq,
  SubscriptionStatusEvent,
  TranslateCtx,
  VerifyCtx,
  VerifyResult,
} from '../../module-types.js';

// Stripe doesn't need a real API key just to verify webhook signatures —
// `webhooks.constructEvent` is offline HMAC. Use a placeholder if
// STRIPE_API_KEY isn't set, since Stripe's constructor requires one even
// when we won't make outbound calls.
const stripeForVerification = new Stripe(env.STRIPE_API_KEY ?? 'sk_for_verify_only', {
  apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
});

/** Payload objects that may carry our app-scoping metadata. */
interface ApplicationScopedObject {
  metadata?: { applicationId?: string | null } | null;
}

function extractApplicationId(obj: ApplicationScopedObject | undefined | null): string | null {
  // The payload is attacker-writable until signature verification passes, and
  // the interface type above is a cast, not a guarantee — so runtime-check the
  // shape. A non-string (array/object/number via a crafted body) must resolve
  // to "no id", never flow onward as an AppRef.
  const id = obj?.metadata?.applicationId;
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : null;
}

/** Map Stripe subscription status strings to our enum values. */
export function mapStripeSubStatus(s: Stripe.Subscription.Status): LocalSubscriptionStatus {
  switch (s) {
    case 'active':
    case 'trialing':
      return 'ACTIVE';
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
 * EXPIRED buckets under `canceled` (terminal — the sub died before/after
 * activating) and PENDING under `past_due` (billing interrupted, not
 * terminal). See SubscriptionStatusEvent in module-types.ts.
 */
function statusEventType(status: LocalSubscriptionStatus): SubscriptionStatusEvent['type'] {
  switch (status) {
    case 'ACTIVE':
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
  // claim — a forged payload naming app X still needs X's signing secret.
  const event = req.payload as { data?: { object?: ApplicationScopedObject } } | null;
  const applicationId = extractApplicationId(event?.data?.object);
  if (applicationId) return { applicationId };
  // No slug and no metadata → nothing to scope credentials by. 401 — an
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
    // the pipeline already holds the parsed body — verification is the only
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
 * Port of the stripe.handler.ts dispatch switch: the same 5 handled event
 * types, translated to normalized domain events. Everything else → null
 * (logged + acked upstream). Application scoping stays payload-metadata
 * based — missing metadata means "cannot route", warn + no events, never
 * guess (see webhooks/AGENTS.md).
 */
function translate(payload: unknown, ctx: TranslateCtx): DomainBillingEvent[] | null {
  const event = payload as Stripe.Event;
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const applicationId = extractApplicationId(session);
      if (!applicationId) {
        ctx.log.warn(
          { sessionId: session.id },
          'checkout.session.completed without applicationId metadata — cannot route',
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
          // Absolute mirror — null clears, matching the pre-module handler.
          currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
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
      const applicationId = extractApplicationId(invoice);
      if (!applicationId) {
        ctx.log.warn({ invoiceId: invoice.id }, 'invoice.paid without applicationId metadata');
        return [];
      }
      return [
        {
          type: 'payment.succeeded',
          providerEventId: event.id,
          applicationId,
          providerPaymentId: invoice.id,
          providerSubscriptionId:
            typeof invoice.subscription === 'string' ? invoice.subscription : null,
          amount: invoice.amount_paid,
          currency: invoice.currency ?? null,
          description: invoice.description ?? null,
          // The FIRST invoice (billing_reason: subscription_create) pays for
          // the period checkout already provisioned — the applier anchors it
          // 'initial' to prevent a double grant.
          firstPeriod: invoice.billing_reason === 'subscription_create',
          raw: payload,
        },
      ];
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const applicationId = extractApplicationId(invoice);
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
          providerSubscriptionId:
            typeof invoice.subscription === 'string' ? invoice.subscription : null,
          amount: invoice.amount_due,
          currency: invoice.currency ?? null,
          description: invoice.description ?? null,
          raw: payload,
        },
      ];
    }
    default:
      return null;
  }
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
    oneTime: true,
    captureStep: false,
    autoWebhookRegister: true,
    periodRotationEvents: true,
    onlineVerify: false,
  },
  credentialSchema: [
    {
      key: 'apiKey',
      label: 'Secret key',
      secret: true,
      placeholder: 'sk_live_… / sk_test_…',
      help: 'Stripe Dashboard → Developers → API keys.',
      pattern: { prefix: 'sk_', message: 'Stripe `apiKey` must start with `sk_` (live or test).' },
    },
    {
      key: 'webhookSecret',
      label: 'Webhook signing secret',
      secret: true,
      optional: true,
      placeholder: 'whsec_…',
      help: 'Leave blank and auto-configure the webhook, or paste it from Stripe → Developers → Webhooks.',
      pattern: {
        prefix: 'whsec_',
        message: 'Stripe `webhookSecret`, when provided, must start with `whsec_`.',
      },
      webhookRole: 'secret',
    },
  ],
  inferMode(creds) {
    // Legacy inference (credentials.service.ts pre-P3): sk_live_ → live,
    // anything else → test.
    return (creds.apiKey ?? '').startsWith('sk_live_') ? 'live' : 'test';
  },
  createProvider(creds) {
    // Same selection the factory (providers/index.ts) applies for the
    // creds-present case: tests and RELIPAY_BILLING_FORCE_STUB short-circuit
    // the real SDK so nothing hits the network; production uses the real SDK
    // unconditionally. (The no-creds → stub fallback stays in the factory —
    // a module is only asked to build a provider from actual credentials.)
    const typed = creds as unknown as StripeCredentials;
    if (process.env.NODE_ENV === 'test' || process.env.RELIPAY_BILLING_FORCE_STUB === 'true') {
      return new StripeStubProvider(typed);
    }
    return new RealStripeProvider(typed);
  },
  webhook: {
    resolveApplication,
    verify,
    extractEventId(payload: unknown): string {
      return (payload as { id?: string }).id as string;
    },
    extractEventType(payload: unknown): string {
      return (payload as { type?: string }).type ?? 'unknown';
    },
    translate,
  },
};

export default stripeModule;
