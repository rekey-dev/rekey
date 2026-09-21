/**
 * External billing system ProviderModule: bring your own billing.
 *
 * Every other module in this directory fronts a payment processor that Rekey
 * sends buyers to. This one fronts a system Rekey never calls: the operator's
 * own billing stack, an invoicing tool, a marketplace, a previous billing
 * platform mid-migration. Money changes hands somewhere Rekey cannot see, and
 * that system tells Rekey what it sold by posting signed events here.
 *
 * It is inbound only (`capabilities.checkout: false`). The geo router never
 * picks it, the public provider list never advertises it, and a plan's
 * readiness reports it as a blocker rather than a channel. What it shares
 * with the other three is everything that matters once an event arrives:
 * per-application credentials, the pipeline's signature gate, durable
 * idempotency on the event id, the retry contract, and the same appliers
 * that mirror a Stripe subscription.
 *
 * ## The wire format
 *
 * Deliberately the same envelope and the same signature scheme Rekey uses
 * for the webhooks it SENDS (docs/webhooks.md), so an integrator who already
 * receives Rekey events can reuse one helper in the other direction:
 *
 *   POST /api/v1/webhooks/billing/external/<app-slug>
 *   X-Rekey-Signature: t=<unix-seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 *   { "eventId": "...", "type": "subscription.activated", "occurredAt": "...", "data": { ... } }
 *
 * `eventId` is the sender's idempotency key. `t` bounds replay to five
 * minutes; a captured body cannot be re-presented later even with a valid
 * signature. The whole envelope is validated before the receipt row is
 * written, so a malformed event answers 400 with the field that failed
 * instead of being stored and retried forever.
 *
 * ## What the events mean
 *
 *   subscription.activated   create the subscriber if unknown, then activate,
 *                            renew (a later period end), recover from past
 *                            due, or rebind a plan change. The one event a
 *                            sender needs; posting it on every change in the
 *                            external system is correct and idempotent.
 *   subscription.canceled    now, or at `effectiveAt` when that is in the
 *                            future (the row keeps its status with `cancelAt`
 *                            set and is ended locally on the date).
 *   subscription.past_due    a payment failed; dunning opens if enabled.
 *   payment.succeeded/failed/refunded
 *                            bookkeeping for the revenue views. Optional.
 *   ping                     verified, logged and acknowledged; changes
 *                            nothing. The first thing an integrator sends.
 *
 * See docs/external-billing.md for the sender's side.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { RekeyError } from '../../../../../lib/error.js';
import type {
  AppRef,
  DomainBillingEvent,
  ProviderModule,
  RawWebhookReq,
  TranslateCtx,
  VerifyCtx,
  VerifyResult,
} from '../../module-types.js';

export const EXTERNAL_PROVIDER_NAME = 'external';

/** Same window `verifyWebhookSignature` in @rekey.dev/node applies to Rekey's own deliveries. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Signing secrets shorter than this are guessable; `openssl rand -hex 32` gives 64. */
const MIN_SECRET_LENGTH = 32;

const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

const ExternalId = z.string().min(1).max(200);

const SubscriberSchema = z
  .object({
    endUserId: z.string().min(1).max(64).optional(),
    email: z.string().email().max(254).optional(),
    /**
     * Whether the sender vouches for the address. Defaults to true: the
     * external system is the operator's own and has usually collected the
     * address at payment. Send false to have Rekey treat it as unverified,
     * which keeps an OIDC sign-in from auto-linking to it.
     */
    emailVerified: z.boolean().optional(),
    /** Beneficiary organization, for Applications that bill per organization. */
    organizationId: z.string().min(1).max(64).optional(),
  })
  .refine((s) => Boolean(s.endUserId) !== Boolean(s.email), {
    message: 'subscriber needs exactly one of endUserId or email',
  });

const ActivatedData = z.object({
  subscription: z.object({
    id: ExternalId,
    plan: z.string().min(1).max(40),
    currentPeriodEnd: isoDate.nullable().optional(),
    trialEndsAt: isoDate.nullable().optional(),
  }),
  subscriber: SubscriberSchema,
});

const CanceledData = z.object({
  subscription: z.object({
    id: ExternalId,
    /** When access ends. Absent or past: now. Future: scheduled. */
    effectiveAt: isoDate.optional(),
  }),
});

const PastDueData = z.object({
  subscription: z.object({ id: ExternalId }),
});

const PaymentData = z.object({
  payment: z.object({
    id: ExternalId,
    subscriptionId: ExternalId,
    /** Smallest currency unit; the applier's `safeAmount` gate still applies. */
    amount: z.number().int().min(0),
    currency: z.string().length(3),
    description: z.string().max(500).nullable().optional(),
  }),
});

const Envelope = z.object({
  eventId: z.string().min(1).max(200),
  type: z.string().min(1).max(80),
  occurredAt: isoDate.optional(),
  data: z.record(z.unknown()).optional(),
});
type Envelope = z.infer<typeof Envelope>;

/** Event types Rekey acts on, and the shape each one's `data` must have. */
const DATA_SCHEMAS: Record<string, z.ZodTypeAny> = {
  ping: z.object({}).passthrough(),
  'subscription.activated': ActivatedData,
  'subscription.canceled': CanceledData,
  'subscription.past_due': PastDueData,
  'payment.succeeded': PaymentData,
  'payment.failed': PaymentData,
  'payment.refunded': PaymentData,
};

/**
 * Parse the envelope and, for a type Rekey acts on, its `data`, refusing a
 * malformed body with 400 and the first failing path.
 *
 * Called from `extractEventId`, which the pipeline runs AFTER the signature
 * check and BEFORE the receipt row: a bad body is refused loudly and stored
 * nowhere, instead of being recorded, failing in the applier, and retried by
 * the sender forever. `translate` parses again; it is pure and cheap. A body
 * that verifies is the sender's own, so the detail in the error is for them.
 */
function parseEvent(payload: unknown): { env: Envelope; data: unknown } {
  const parsed = Envelope.safeParse(payload);
  if (!parsed.success) throw payloadInvalid(parsed.error);
  const env = parsed.data;
  // Own keys only: `type` is sender-chosen, and "constructor" or "toString"
  // would otherwise resolve to Object.prototype and blow up in safeParse.
  const schema = Object.hasOwn(DATA_SCHEMAS, env.type) ? DATA_SCHEMAS[env.type] : undefined;
  if (!schema) return { env, data: env.data };
  const data = schema.safeParse(env.data ?? {});
  if (!data.success) throw payloadInvalid(data.error, env.type);
  return { env, data: data.data };
}

function payloadInvalid(error: z.ZodError, eventType?: string): RekeyError {
  // The first failing path and its message are enough to fix a sender; the
  // full issue list would only repeat what one iteration of fixing reveals.
  const first = error.issues[0];
  const at = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
  return new RekeyError({
    statusCode: 400,
    code: 'WEBHOOK_PAYLOAD_INVALID',
    message: `${eventType ? `"${eventType}" event` : 'Event'} body is not valid${at}: ${first?.message ?? 'invalid'}.`,
    fix: 'See docs/external-billing.md for the envelope and the fields each event type carries.',
  });
}

function resolveApplication(req: RawWebhookReq): AppRef {
  // Slug only. The body is unverified at this point and the slug is what
  // selects the secret that will verify it; nothing in the body may do that.
  if (req.params.slug) return { slug: req.params.slug };
  throw new RekeyError({
    statusCode: 401,
    code: 'WEBHOOK_APPLICATION_UNRESOLVED',
    message: 'External billing webhook URL carries no application slug.',
    fix: 'Post to /api/v1/webhooks/billing/external/<app-slug>.',
  });
}

function parseSignatureHeader(header: string): { t: number; v1: string } | null {
  const parts: Record<string, string> = {};
  for (const p of header.split(',')) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/i.test(v1)) return null;
  return { t, v1 };
}

async function verify(
  req: RawWebhookReq,
  creds: Record<string, string>,
  _ctx: VerifyCtx,
): Promise<VerifyResult> {
  const header = req.headers['x-rekey-signature'];
  if (typeof header !== 'string' || header.length === 0) {
    return {
      ok: false,
      code: 'WEBHOOK_SIGNATURE_MISSING',
      message: 'Missing X-Rekey-Signature header.',
      fix: 'Sign the raw body: X-Rekey-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>.',
    };
  }
  const sig = parseSignatureHeader(header);
  if (!sig) {
    return {
      ok: false,
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'X-Rekey-Signature is not in the form t=<unix seconds>,v1=<64 hex chars>.',
      fix: 'See docs/external-billing.md for the signing recipe.',
    };
  }
  // The timestamp is checked before the HMAC so a stale-but-valid capture is
  // named as stale; both answer 401, so nothing about the secret leaks.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - sig.t) > SIGNATURE_TOLERANCE_SECONDS) {
    return {
      ok: false,
      code: 'WEBHOOK_SIGNATURE_STALE',
      message: `Signature timestamp is more than ${SIGNATURE_TOLERANCE_SECONDS} seconds from the server clock.`,
      fix: 'Sign at send time with the current unix time, and keep the sending host clock synchronised.',
    };
  }
  // The pipeline refuses the request before this when the secret is unset;
  // an HMAC over an empty key must still never be a way in.
  if (!creds.webhookSecret) {
    return {
      ok: false,
      statusCode: 503,
      code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
      message: 'This Application has no signing secret for the external billing provider.',
      fix: 'Save a signing secret on the Billing tab, then resend.',
    };
  }
  const expected = createHmac('sha256', creds.webhookSecret)
    .update(`${sig.t}.${req.rawBody}`)
    .digest();
  const given = Buffer.from(sig.v1, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return {
      ok: false,
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'External billing webhook signature is invalid.',
      fix: 'The secret must match the one saved for this Application, and the HMAC must cover the exact raw bytes sent.',
    };
  }
  return { ok: true };
}

function extractEventId(payload: unknown): string {
  return parseEvent(payload).env.eventId;
}

function extractEventType(payload: unknown): string {
  const e = payload as { type?: unknown };
  return typeof e?.type === 'string' ? e.type : 'unknown';
}

function translate(payload: unknown, ctx: TranslateCtx): DomainBillingEvent[] | null {
  const { env, data } = parseEvent(payload);
  // The Application is the route's, always: the slug selected the secret
  // that verified this body, and nothing in the body may redirect it.
  const applicationId = ctx.applicationId;
  if (!applicationId) {
    ctx.log.error({ eventType: env.type }, 'external billing translate without a route-resolved application');
    return [];
  }
  const providerEventId = env.eventId;
  const raw = payload;

  switch (env.type) {
    case 'ping':
      // Verified and logged as a processed receipt; nothing to apply.
      return [];

    case 'subscription.activated': {
      const d = data as z.infer<typeof ActivatedData>;
      const s = d.subscriber;
      return [
        {
          type: 'subscription.granted',
          providerEventId,
          applicationId,
          provider: EXTERNAL_PROVIDER_NAME,
          providerSubscriptionId: d.subscription.id,
          planSlug: d.subscription.plan,
          subscriber: s.endUserId
            ? { endUserId: s.endUserId }
            : { email: s.email!, ...(s.emailVerified !== undefined && { emailVerified: s.emailVerified }) },
          ...(s.organizationId !== undefined && { organizationId: s.organizationId }),
          ...(d.subscription.currentPeriodEnd !== undefined && {
            currentPeriodEnd: d.subscription.currentPeriodEnd,
          }),
          ...(d.subscription.trialEndsAt !== undefined && { trialEndsAt: d.subscription.trialEndsAt }),
          raw,
        },
      ];
    }

    case 'subscription.canceled': {
      const d = data as z.infer<typeof CanceledData>;
      const now = new Date();
      const effectiveAt = d.subscription.effectiveAt;
      if (effectiveAt && effectiveAt > now) {
        // Scheduled: the row keeps whatever status it has (ACTIVE stays
        // entitled, PAST_DUE stays in dunning) until the date, when
        // `expireIfDue` ends it locally, the same way a period-end
        // cancellation the buyer asked for behaves. No status is sent: the
        // event says when access ends, not what the subscription is now.
        return [
          {
            type: 'subscription.canceled',
            providerEventId,
            applicationId,
            providerSubscriptionId: d.subscription.id,
            cancelAt: effectiveAt,
            raw,
          },
        ];
      }
      const at = effectiveAt ?? env.occurredAt ?? now;
      return [
        {
          type: 'subscription.canceled',
          providerEventId,
          applicationId,
          providerSubscriptionId: d.subscription.id,
          status: 'CANCELED',
          cancelAt: at,
          canceledAt: at,
          raw,
        },
      ];
    }

    case 'subscription.past_due': {
      const d = data as z.infer<typeof PastDueData>;
      return [
        {
          type: 'subscription.past_due',
          providerEventId,
          applicationId,
          providerSubscriptionId: d.subscription.id,
          status: 'PAST_DUE',
          raw,
        },
      ];
    }

    case 'payment.succeeded': {
      const { payment } = data as z.infer<typeof PaymentData>;
      return [
        {
          type: 'payment.succeeded',
          providerEventId,
          applicationId,
          providerPaymentId: payment.id,
          providerSubscriptionId: payment.subscriptionId,
          // No `requireLocalSubscription`: a charge for a subscription Rekey
          // does not hold is still recorded, unlinked, and reaches the
          // operator's unapplied-payments queue. Money that moved is a fact,
          // and the sender's bookkeeping being ahead of Rekey's is exactly
          // when an operator needs to see it.
          amount: payment.amount,
          currency: payment.currency.toUpperCase(),
          description: payment.description ?? null,
          // Renewals arrive as `subscription.activated` with the new period
          // end; a payment never provisions a period on its own here.
          firstPeriod: false,
          raw,
        },
      ];
    }

    case 'payment.failed': {
      const { payment } = data as z.infer<typeof PaymentData>;
      return [
        {
          type: 'payment.failed',
          providerEventId,
          applicationId,
          providerPaymentId: payment.id,
          providerSubscriptionId: payment.subscriptionId,
          requireLocalSubscription: true,
          amount: payment.amount,
          currency: payment.currency.toUpperCase(),
          description: payment.description ?? null,
          raw,
        },
      ];
    }

    case 'payment.refunded': {
      const { payment } = data as z.infer<typeof PaymentData>;
      return [
        {
          type: 'payment.refunded',
          providerEventId,
          applicationId,
          providerPaymentId: payment.id,
          providerSubscriptionId: payment.subscriptionId,
          amount: payment.amount,
          currency: payment.currency.toUpperCase(),
          description: payment.description ?? null,
          raw,
        },
      ];
    }

    default:
      // Unknown types are acknowledged and logged, never refused: a sender
      // may post its whole catalogue and let Rekey pick what it understands.
      return null;
  }
}

export const externalModule: ProviderModule = {
  name: EXTERNAL_PROVIDER_NAME,
  display: {
    label: 'External billing system',
    docsUrl: 'https://github.com/rekey-dev/rekey/blob/main/docs/external-billing.md',
    // Never routed to, so there is nothing to pre-fill.
    defaultCountries: [],
    priority: 1000,
  },
  capabilities: {
    checkout: false,
    oneTime: false,
    captureStep: false,
    // The "webhook" is the sender's own code; there is no dashboard to
    // register anything in. The panel shows the endpoint and the recipe.
    autoWebhookRegister: false,
    // Renewals carry the new period end on `subscription.activated`.
    periodRotationEvents: true,
    onlineVerify: false,
    trials: false,
    discounts: { oneTime: false, recurring: false },
  },
  // Every plan is a blocker for this module: it cannot host a checkout for
  // any of them. Reported per plan so an Application whose only provider is
  // external sees, on the Plans tab, why a Buy button would be refused.
  planCheckoutBlocker() {
    return {
      code: 'PROVIDER_INBOUND_ONLY',
      message:
        'An external billing system activates subscriptions by posting events; it cannot host a checkout.',
      fix: 'Sell through the external system and let it post subscription.activated, or connect a payment provider for self-serve checkout.',
    };
  },
  credentialSchema: [
    {
      key: 'webhookSecret',
      label: 'Signing secret',
      secret: true,
      placeholder: 'at least 32 random characters',
      help:
        'Your billing system signs every event with HMAC-SHA256 using this secret. ' +
        'Generate one with `openssl rand -hex 32` and store it on both sides.',
      pattern: {
        regex: `^.{${MIN_SECRET_LENGTH},}$`,
        message: `The signing secret must be at least ${MIN_SECRET_LENGTH} characters.`,
      },
      webhookRole: 'secret',
    },
    // The PULL half. Both optional: an Application that only ever receives
    // events needs neither, and leaving them blank means the subscription
    // import is unavailable rather than broken.
    {
      key: 'subscriptionsUrl',
      label: 'Subscriptions endpoint (optional)',
      secret: false,
      optional: true,
      placeholder: 'https://billing.example.com/rekey/subscriptions',
      help:
        'A GET endpoint your billing system hosts, listing the subscriptions it has sold. Rekey ' +
        'reads it to import a book of business it never saw — the event feed only covers what ' +
        'happens after you connect. The exact contract is in docs/external-billing-pull.md.',
      pattern: {
        prefix: 'https://',
        message: 'The subscriptions endpoint must be an https:// URL.',
      },
    },
    {
      key: 'pullToken',
      label: 'Pull token (optional)',
      secret: true,
      optional: true,
      placeholder: 'a bearer token your endpoint accepts',
      help:
        'Sent as `Authorization: Bearer` when Rekey reads the subscriptions endpoint. Rekey also ' +
        'signs each read with the signing secret above, so you can tell the caller is Rekey and ' +
        'not somebody who found the URL.',
    },
  ],
  webhook: {
    resolveApplication,
    verify,
    extractEventId,
    extractEventType,
    translate,
  },
};

export default externalModule;
