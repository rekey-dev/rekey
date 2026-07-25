/**
 * Razorpay ProviderModule (docs/specs/billing-provider-modules.md, P2).
 *
 * Bundles what used to be spread across razorpay.routes.ts (offline
 * HMAC-SHA256 verification, header-borne event id) and razorpay.handler.ts
 * (the 7-event dispatch switch) into one descriptor. Every mapping is a
 * straight port — CI's razorpay-webhook suite pins the behavior through the
 * legacy alias URL.
 *
 * Application scoping is the URL slug (Razorpay events do NOT echo our app
 * id reliably); the signing secret that validates the request is that app's
 * own, so the slug is trustworthy. Local rows match by the Razorpay object
 * id stored at checkout in `metadata.checkoutSessionId` OR by
 * `providerSubId` once persisted — the events carry `checkoutSessionId` so
 * the shared appliers keep that OR-match.
 *
 * Credential JSON keys (`keyId`, `keySecret`, `webhookSecret`) match the
 * stored encrypted blobs exactly — zero data migration (see
 * RazorpayCredentials in credentials.service.ts).
 */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { RelipayError } from '../../../../../lib/error.js';
import { RazorpayStubProvider, RealRazorpayProvider } from '../../razorpay.js';
import type { RazorpayCredentials } from '../../../credentials.service.js';
import type {
  AppRef,
  DomainBillingEvent,
  ProviderModule,
  RawWebhookReq,
  TranslateCtx,
  VerifyCtx,
  VerifyResult,
} from '../../module-types.js';

// ---------- Razorpay payload shapes (the subset we read) ----------

interface RzpSubscriptionEntity {
  id: string;
  status?: string;
  current_end?: number | null;
  paid_count?: number;
}

interface RzpPaymentEntity {
  id: string;
  amount?: number;
  currency?: string;
  description?: string | null;
}

interface RzpPaymentLinkEntity {
  id: string;
}

interface RazorpayEventPayload {
  event?: string;
  created_at?: number;
  payload?: {
    subscription?: { entity?: RzpSubscriptionEntity };
    payment?: { entity?: RzpPaymentEntity };
    payment_link?: { entity?: RzpPaymentLinkEntity };
  };
}

/** Timing-safe hex-digest compare. Returns false on any length mismatch. */
function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function resolveApplication(req: RawWebhookReq): AppRef {
  // Slug-scoped only — Razorpay payloads carry nothing to scope credentials
  // by, so a slug-less request is unverifiable → unauthenticated.
  if (req.params.slug) return { slug: req.params.slug };
  throw new RelipayError({
    statusCode: 401,
    code: 'WEBHOOK_APPLICATION_UNRESOLVED',
    message: 'Razorpay webhook URL carries no application slug.',
    fix: 'Point Razorpay at the per-application endpoint (…/webhooks/billing/razorpay/<appSlug>).',
  });
}

async function verify(req: RawWebhookReq, creds: Record<string, string>, _ctx: VerifyCtx): Promise<VerifyResult> {
  const sig = req.headers['x-razorpay-signature'];
  if (typeof sig !== 'string') {
    return {
      ok: false,
      code: 'WEBHOOK_SIGNATURE_MISSING',
      message: 'Missing x-razorpay-signature header.',
      fix: 'Razorpay sets this automatically; for tests sign the raw body with HMAC-SHA256(secret).',
    };
  }
  // Offline HMAC-SHA256 hex over the exact raw bytes with the app's own
  // webhook secret (BYO, per-application — no global fallback).
  const expected = createHmac('sha256', creds.webhookSecret ?? '').update(req.rawBody).digest('hex');
  if (!safeEqualHex(expected, sig)) {
    return {
      ok: false,
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Razorpay webhook signature is invalid.',
      fix: 'Check the webhook secret matches what Razorpay shows for this endpoint.',
    };
  }
  return { ok: true };
}

/**
 * Razorpay has no event id in the body — its per-delivery unique id rides
 * on the `x-razorpay-event-id` header. Fall back to a deterministic
 * composite if (only ever in non-Razorpay test harnesses) it's absent, so
 * idempotency still has a stable key.
 */
function extractEventId(payload: unknown, req?: RawWebhookReq): string {
  const headerId = req?.headers['x-razorpay-event-id'];
  if (typeof headerId === 'string' && headerId.length > 0) return headerId;
  const e = payload as RazorpayEventPayload;
  const bodyDigest = createHash('sha256')
    .update(req?.rawBody ?? '')
    .digest('hex')
    .slice(0, 24);
  return `rzp_${e.event ?? 'unknown'}_${e.created_at ?? ''}_${bodyDigest}`;
}

/**
 * Port of the razorpay.handler.ts dispatch switch — the same 7 handled
 * event types (incl. the payment_link.paid one-time path), translated to
 * normalized domain events. Everything else → null (logged + acked
 * upstream). All events carry `checkoutSessionId` so the appliers keep the
 * bespoke metadata-OR-providerSubId row matching, and payment events set
 * `requireLocalSubscription` — the bespoke handler never wrote an unlinked
 * Payment for an unmatched Razorpay event.
 */
function translate(payload: unknown, ctx: TranslateCtx): DomainBillingEvent[] | null {
  const event = payload as RazorpayEventPayload;
  const applicationId = ctx.applicationId;
  if (!applicationId) {
    // Slug-scoped provider: translation outside the pipeline has no app to
    // target. Never guess.
    ctx.log.error({ eventType: event.event }, 'razorpay translate without a route-resolved application');
    return [];
  }
  const providerEventId = ctx.providerEventId ?? extractEventId(payload);
  const sub = event.payload?.subscription?.entity;
  const payment = event.payload?.payment?.entity;

  switch (event.event) {
    // PENDING → ACTIVE, persist providerSubId (= the Razorpay sub id stored
    // in metadata.checkoutSessionId at checkout), mirror current_end,
    // provision the first period (anchor 'initial' so the first charged
    // event collides with it instead of double-granting).
    case 'subscription.activated':
    case 'subscription.authenticated': {
      if (!sub) {
        ctx.log.warn({ eventId: providerEventId }, 'subscription.activated without subscription entity');
        return [];
      }
      return [
        {
          type: 'checkout.completed',
          providerEventId,
          applicationId,
          checkoutSessionId: sub.id,
          providerSubscriptionId: sub.id,
          ...(sub.current_end ? { currentPeriodEnd: new Date(sub.current_end * 1000) } : {}),
          raw: payload,
        },
      ];
    }
    // SUCCEEDED Payment + ensure ACTIVE + mirror current_end (all in one
    // transaction, applier-side) + recover dunning + (re)provision.
    // firstPeriod when paid_count <= 1 — the first charge pays for the SAME
    // period the activation already provisioned.
    case 'subscription.charged': {
      if (!sub || !payment) {
        ctx.log.warn({ eventId: providerEventId }, 'subscription.charged missing subscription/payment entity');
        return [];
      }
      return [
        {
          type: 'payment.succeeded',
          providerEventId,
          applicationId,
          providerPaymentId: payment.id,
          providerSubscriptionId: sub.id,
          checkoutSessionId: sub.id,
          requireLocalSubscription: true,
          amount: payment.amount,
          currency: payment.currency ?? 'INR',
          description: payment.description ?? null,
          firstPeriod: (sub.paid_count ?? 1) <= 1,
          ...(sub.current_end ? { currentPeriodEnd: new Date(sub.current_end * 1000) } : {}),
          raw: payload,
        },
      ];
    }
    case 'subscription.cancelled': {
      if (!sub) return [];
      return [
        {
          type: 'subscription.canceled',
          providerEventId,
          applicationId,
          providerSubscriptionId: sub.id,
          checkoutSessionId: sub.id,
          status: 'CANCELED',
          canceledAt: new Date((event.created_at ?? Math.floor(Date.now() / 1000)) * 1000),
          raw: payload,
        },
      ];
    }
    // Razorpay subscriptions run a finite total_count; `completed` fires
    // once all cycles are charged. A natural end, not a cancellation —
    // status EXPIRED emits no outbound lifecycle event (the mirror applier
    // only closes any lingering dunning case).
    case 'subscription.completed': {
      if (!sub) return [];
      return [
        {
          type: 'subscription.canceled',
          providerEventId,
          applicationId,
          providerSubscriptionId: sub.id,
          checkoutSessionId: sub.id,
          status: 'EXPIRED',
          raw: payload,
        },
      ];
    }
    // halted = retries exhausted; pending = a charge failed, Razorpay
    // retrying. Both → PAST_DUE + dunning. When the event carries the
    // failed charge, payment.failed records it (FAILED row + PAST_DUE in
    // one transaction + recordPaymentFailure); the trailing status mirror
    // is then a no-op echo (ensureCaseOpen bumps no counter). Without a
    // payment entity the mirror alone flips the status and opens the case.
    case 'subscription.halted':
    case 'subscription.pending': {
      if (!sub) return [];
      const events: DomainBillingEvent[] = [];
      if (payment) {
        events.push({
          type: 'payment.failed',
          providerEventId,
          applicationId,
          providerPaymentId: payment.id,
          providerSubscriptionId: sub.id,
          checkoutSessionId: sub.id,
          requireLocalSubscription: true,
          amount: payment.amount,
          currency: payment.currency ?? 'INR',
          description: payment.description ?? null,
          raw: payload,
        });
      }
      events.push({
        type: 'subscription.past_due',
        providerEventId,
        applicationId,
        providerSubscriptionId: sub.id,
        checkoutSessionId: sub.id,
        status: 'PAST_DUE',
        raw: payload,
      });
      return events;
    }
    // One-off purchase (CREDIT pack / perpetual license) via a Payment
    // Link. The local row was created at checkout with
    // metadata.checkoutSessionId = payment-link id; there is no provider
    // subscription. firstPeriod pins the single-period provision to the
    // 'initial' anchor so replays grant nothing twice.
    case 'payment_link.paid': {
      const link = event.payload?.payment_link?.entity;
      if (!link || !payment) {
        ctx.log.warn({ eventId: providerEventId }, 'payment_link.paid missing payment_link/payment entity');
        return [];
      }
      return [
        {
          type: 'payment.succeeded',
          providerEventId,
          applicationId,
          providerPaymentId: payment.id,
          providerSubscriptionId: null,
          checkoutSessionId: link.id,
          requireLocalSubscription: true,
          amount: payment.amount,
          currency: payment.currency ?? 'INR',
          description: payment.description ?? null,
          firstPeriod: true,
          raw: payload,
        },
      ];
    }
    default:
      return null;
  }
}

export const razorpayModule: ProviderModule = {
  name: 'razorpay',
  display: {
    label: 'Razorpay',
    docsUrl: 'https://razorpay.com/docs/webhooks/',
    // Historical geo-routing default: India routes to Razorpay when
    // configured (see pickProvider).
    defaultCountries: ['IN'],
    priority: 100,
  },
  capabilities: {
    oneTime: true,
    captureStep: false,
    // No webhook-registration API surface on the provider class — the panel
    // sends operators to the Razorpay dashboard to paste the secret
    // manually (registerWebhook is undefined on RealRazorpayProvider, so
    // auto-config 400s with BILLING_WEBHOOK_AUTOCONFIG_UNSUPPORTED).
    autoWebhookRegister: false,
    // subscription.charged carries the new current_end — the period rotates
    // off the provider's own event, no local advance needed.
    periodRotationEvents: true,
    onlineVerify: false,
  },
  credentialSchema: [
    {
      key: 'keyId',
      label: 'Key ID',
      secret: false,
      placeholder: 'rzp_live_… / rzp_test_…',
      help: 'Razorpay Dashboard → Settings → API Keys.',
      pattern: { prefix: 'rzp_', message: 'Razorpay `keyId` must start with `rzp_` (live or test).' },
    },
    {
      key: 'keySecret',
      label: 'Key secret',
      secret: true,
      help: 'Shown once when the key pair is generated.',
    },
    {
      key: 'webhookSecret',
      label: 'Webhook secret',
      secret: true,
      help: 'The secret you chose when creating the webhook in Razorpay Dashboard → Settings → Webhooks.',
      webhookRole: 'secret',
    },
  ],
  inferMode(creds) {
    // Legacy inference (credentials.service.ts pre-P3): rzp_live_ → live,
    // anything else → test.
    return (creds.keyId ?? '').startsWith('rzp_live_') ? 'live' : 'test';
  },
  createProvider(creds) {
    // Same selection the factory (providers/index.ts) applies for the
    // creds-present case: tests and RELIPAY_BILLING_FORCE_STUB short-circuit
    // the real SDK; production uses it unconditionally.
    if (process.env.NODE_ENV === 'test' || process.env.RELIPAY_BILLING_FORCE_STUB === 'true') {
      return new RazorpayStubProvider();
    }
    return new RealRazorpayProvider(creds as unknown as RazorpayCredentials);
  },
  webhook: {
    resolveApplication,
    verify,
    extractEventId,
    extractEventType(payload: unknown): string {
      return (payload as RazorpayEventPayload).event ?? 'unknown';
    },
    translate,
  },
};

export default razorpayModule;
