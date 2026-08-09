/**
 * ProviderModule — the self-describing billing-provider contract
 * (docs/specs/billing-provider-modules.md).
 *
 * One provider = one module under `providers/modules/<name>/` implementing
 * this descriptor. The static registry (`registry.ts`) derives everything
 * else from it: the provider-name enum, the generic webhook pipeline route,
 * and (P3/P4) the generic credentials service + discovery endpoints.
 *
 * The OUTBOUND side (`BillingProvider`, ./types.ts) predates this contract and
 * is untouched by it: providers are still constructed by the switch in
 * providers/index.ts. This file is the INBOUND half only — webhook
 * verification and event translation — which the three bespoke route/handler
 * pairs previously each solved differently.
 */

import type { FastifyBaseLogger } from 'fastify';

/**
 * One credential input field. The generic credentials service (P3) builds
 * its zod schema from these; the panel (P4) renders the form from them.
 * `key` MUST match the JSON key stored in the encrypted credential blob
 * today — the whole point is zero data migration.
 */
export interface CredentialField {
  key: string;
  label: string;
  /** true → password input in the panel, never echoed by any API response. */
  secret: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
  /** Shape validation ('sk_', 'whsec_', 'rzp_'…) with an operator-readable message. */
  pattern?: { prefix?: string; regex?: string; message: string };
  /**
   * Marks the field that makes inbound webhooks verifiable — a signing
   * secret (Stripe/Razorpay) or a provider-side webhook id (PayPal).
   * Unifies the webhookSecret-vs-webhookId divergence for
   * `hasWebhookConfigured` and the pipeline's 503 gate.
   *
   * AT MOST ONE field per module may carry this (registry-integrity test
   * enforces it — the pipeline's gate checks a single field by design).
   * `optional` on the same field refers to the initial credential save
   * only; an empty webhookRole field still 503s inbound webhooks until set.
   */
  webhookRole?: 'secret' | 'id';
}

/**
 * The slice of an inbound webhook request a module may read. `payload` is
 * the JSON-parsed body; `rawBody` is the exact bytes for HMAC verification
 * (any reserialization breaks the signature).
 */
export interface RawWebhookReq {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  params: { provider?: string; slug?: string };
  payload: unknown;
}

/**
 * Signature-verification outcome. A failure carries the error envelope
 * fields the pipeline turns into a 401 — modules never touch the reply.
 */
export type VerifyResult =
  | { ok: true }
  /**
   * `statusCode` defaults to 401 (the signature did not check out). A module
   * whose verification is ONLINE sets 503 when the failure was its inability
   * to REACH the provider — a different fact, and one the provider must be
   * told correctly or it will disable the endpoint for our outage.
   */
  | { ok: false; statusCode?: number; code: string; message: string; fix?: string };

/**
 * Application scoping reference. Normalizes the divergence: Stripe resolves
 * from the URL slug (falling back to payload `metadata.applicationId`),
 * Razorpay/PayPal from the URL slug. The pipeline resolves either to an
 * Application row.
 */
export type AppRef = { applicationId: string } | { slug: string };

/**
 * Local subscription statuses (mirrors the Prisma enum literals). Declared
 * here so modules/appliers don't depend on the generated client's enum
 * export shape.
 */
export type LocalSubscriptionStatus =
  | 'ACTIVE'
  | 'TRIALING'
  | 'PAST_DUE'
  | 'CANCELED'
  | 'EXPIRED'
  | 'PENDING';

interface DomainEventBase {
  /** Provider's event id — the idempotency key stored in `webhook_events`. */
  providerEventId: string;
  /**
   * The Application this event targets. For Stripe this comes from payload
   * `metadata.applicationId` (the historical scoping model — see
   * webhooks/AGENTS.md); for slug-scoped providers it's the route-resolved
   * application.
   */
  applicationId: string;
  /** The full provider payload, for metadata/debugging. Never re-verified. */
  raw: unknown;
}

export interface CheckoutCompletedEvent extends DomainEventBase {
  type: 'checkout.completed';
  /** Provider checkout-session id — matches local `metadata.checkoutSessionId`. */
  checkoutSessionId: string;
  providerSubscriptionId: string | null;
  /**
   * Period anchor carried by the provider's activation payload (Razorpay
   * `current_end`). `undefined` = leave the column untouched (Stripe/PayPal
   * activations don't carry one); written in the same update as the
   * ACTIVE flip.
   */
  currentPeriodEnd?: Date;
  /**
   * Whether the activation provisions the subscription's FIRST period
   * (anchor 'initial'). Default true — the historical checkout semantics.
   * PayPal's ACTIVATED port sets false so a reactivation provisions against
   * the CURRENT period anchor exactly as the bespoke handler did (for a
   * fresh activation `currentPeriodEnd` is null and both spellings anchor
   * 'initial').
   */
  firstPeriod?: boolean;
  /**
   * The charge this completion settled, when the completion payload carries
   * it. Present for ONE-TIME checkouts (Stripe `mode: 'payment'`, where the
   * session reports `payment_intent`, `amount_total` and `payment_status`);
   * absent for recurring ones, whose money arrives on a separate invoice
   * event.
   *
   * It exists because one-time revenue had no `Payment` row anywhere. Stripe
   * emits no invoice for `mode: 'payment'`, and the deployment's webhook
   * registration subscribes to invoice events only — so a completed credit
   * pack granted the credits and recorded no payment at all. Rather than
   * subscribe `payment_intent.succeeded` (which also fires for every invoice
   * payment, carries no link back to the local row, and would have to be
   * de-duplicated against `invoice.paid`), the completion event that already
   * routes to the right subscription carries the charge.
   */
  payment?: {
    providerPaymentId: string;
    /** Smallest currency unit, passed through UNVALIDATED — see `safeAmount`. */
    amount: number | null | undefined;
    currency: string | null;
    description: string | null;
  };
}

/**
 * A one-time order the buyer approved but the provider does NOT capture
 * automatically (PayPal Orders v2 — capabilities.captureStep). The applier
 * captures via the module's provider, then completes fulfillment (ACTIVE +
 * provision). Kept separate from `checkout.completed` because capture is a
 * provider API call and may legitimately leave the row PENDING.
 */
export interface CheckoutApprovedEvent extends DomainEventBase {
  type: 'checkout.approved';
  /** Provider order id — matches local `metadata.checkoutSessionId`. */
  checkoutSessionId: string;
  /** Registry name of the emitting module, for the capture provider lookup. */
  provider: string;
}

interface PaymentEventBase extends DomainEventBase {
  providerPaymentId: string;
  providerSubscriptionId: string | null;
  /**
   * Additional local-row matcher: providers whose checkout stored the
   * provider object id in `metadata.checkoutSessionId` (Razorpay — the
   * subscription id for recurring plans, the payment-link id for one-offs)
   * set this so events match rows that predate `providerSubId` persistence.
   * The appliers OR it with the `providerSubId` match; absent (Stripe,
   * PayPal) the lookup is exactly the historical `providerSubId`-only query.
   */
  checkoutSessionId?: string;
  /**
   * When true, the applier records nothing unless a local subscription
   * matched (Razorpay's historical posture — its bespoke handler dropped
   * unmatched events instead of writing an unlinked Payment row). Absent
   * (Stripe, PayPal) an unmatched payment is still recorded, unlinked.
   */
  requireLocalSubscription?: boolean;
  /**
   * Raw amount in the smallest currency unit, passed through UNVALIDATED —
   * the applier's `safeAmount` gate (finite/integer/≥0/≤cap) decides whether
   * to record or log-and-drop, preserving the poisoned-row protections.
   */
  amount: number | null | undefined;
  currency: string | null;
  description: string | null;
}

export interface PaymentSucceededEvent extends PaymentEventBase {
  type: 'payment.succeeded';
  /**
   * True when this payment pays for the subscription's FIRST period (Stripe
   * `billing_reason: subscription_create`, Razorpay `paid_count <= 1`). The
   * entitlements provision then anchors on 'initial' so it collides with the
   * checkout-time grant instead of double-granting (webhooks don't arrive in
   * order).
   */
  firstPeriod: boolean;
  /**
   * New period anchor carried on the charge itself (Razorpay `current_end`).
   * `undefined` = leave the column untouched. Written INSIDE the payment
   * transaction (a committed charge must never be stranded from its period
   * change), before the post-commit re-provision reads the row back — so the
   * renewal grant anchors on the NEW period, as the bespoke handler did.
   */
  currentPeriodEnd?: Date;
}

export interface PaymentFailedEvent extends PaymentEventBase {
  type: 'payment.failed';
}

export interface PaymentRefundedEvent extends PaymentEventBase {
  type: 'payment.refunded';
}

/**
 * Subscription status mirror. The `status` field is AUTHORITATIVE — appliers
 * key every DB write, outbound emission, and dunning call off it; the event
 * `type` only picks the applier. This is deliberate: Stripe's
 * `customer.subscription.updated` can map to local statuses (EXPIRED,
 * PENDING) that have no first-class domain event, and dropping those would
 * change the absolute-mirror behavior the July-audit tests pin. Translate
 * buckets them under the nearest lifecycle type (EXPIRED → canceled,
 * PENDING → past_due); appliers emit outbound events only for
 * ACTIVE/CANCELED/PAST_DUE statuses, exactly as before.
 *
 * `currentPeriodEnd`/`cancelAt`/`canceledAt`: `undefined` = leave the column
 * untouched; `null`/value = write it. (subscription.updated writes all
 * three, absolute; subscription.deleted writes only canceledAt.)
 */
export interface SubscriptionStatusEvent extends DomainEventBase {
  type: 'subscription.activated' | 'subscription.canceled' | 'subscription.past_due';
  providerSubscriptionId: string;
  /** See PaymentEventBase.checkoutSessionId — same OR-matcher, same rules. */
  checkoutSessionId?: string;
  status: LocalSubscriptionStatus;
  currentPeriodEnd?: Date | null;
  /**
   * When the trial ends, for a subscription the provider is running a trial
   * on. Mirrored so the panel can say "trial ends in 4 days" and so a
   * converted trial stays reportable — the status moves to ACTIVE, and
   * without the date nothing records that the customer arrived via a trial.
   */
  trialEndsAt?: Date | null;
  cancelAt?: Date | null;
  canceledAt?: Date | null;
}

/**
 * Advance the local billing period by one plan interval (calendar-aware).
 * First-class replacement for the PayPal-only `advanceBillingPeriod`
 * workaround — providers that never emit a period-rotation event
 * (capabilities.periodRotationEvents: false) translate their renewal
 * payment into this. Stripe doesn't need it (subscription.updated carries
 * the new `current_period_end` directly).
 */
export interface SubscriptionPeriodAdvancedEvent extends DomainEventBase {
  type: 'subscription.period_advanced';
  providerSubscriptionId: string;
  /**
   * When set, the rotation is PAYMENT-DERIVED (PayPal: a renewal sale, not
   * a native period event) and the applier applies the renewal gate the
   * bespoke handler had: advance only if this provider payment id is not
   * yet recorded (a replayed sale must not advance twice) AND a prior
   * SUCCEEDED payment exists for the subscription (the first sale funds the
   * period the activation already provisioned). Absent → unconditional
   * advance, the original P1 contract.
   */
  providerPaymentId?: string;
}

/**
 * The normalized inbound event set. Modules translate provider payloads
 * into these; core (`webhooks/apply.ts`) owns what happens next. Status
 * maps and provider payload shapes die inside modules.
 */
export type DomainBillingEvent =
  | CheckoutCompletedEvent
  | CheckoutApprovedEvent
  | PaymentSucceededEvent
  | PaymentFailedEvent
  | PaymentRefundedEvent
  | SubscriptionStatusEvent
  | SubscriptionPeriodAdvancedEvent;

/** Context threaded into `translate`. */
export interface TranslateCtx {
  log: FastifyBaseLogger;
  /**
   * The route-resolved application id, for slug-scoped providers whose
   * payloads don't carry it. Null when translation happens outside the
   * pipeline (compatibility shims). Stripe ignores it — its scoping model
   * reads payload metadata (never guess; see webhooks/AGENTS.md).
   */
  applicationId: string | null;
  /**
   * The pipeline-extracted provider event id, for providers whose event id
   * is NOT in the payload (Razorpay: the `x-razorpay-event-id` header).
   * Payload-carried ids (Stripe, PayPal) don't need it.
   */
  providerEventId?: string;
}

/** Context threaded into `verify` — the credential row's test/live mode. */
export interface VerifyCtx {
  /** Sandbox vs live, for online verifiers with per-mode base URLs (PayPal). */
  mode: 'test' | 'live';
}

/**
 * The self-describing provider module. See the spec for field-by-field
 * rationale; the registry CI test asserts `name` equals the directory name.
 */
export interface ProviderModule {
  /** 'stripe' — must equal the directory name under providers/modules/. */
  name: string;
  display: {
    label: string;
    /** Provider setup guide for operators. */
    docsUrl: string;
    /**
     * SUGGESTED geo-routing values, surfaced through the discovery projection so
     * the panel can pre-fill the credential form. `pickProvider` never reads
     * these — it routes purely on what is stored on the credential row.
     */
    defaultCountries: string[];
    priority: number;
  };
  capabilities: {
    /** Supports one-time checkouts. */
    oneTime: boolean;
    /** Needs an explicit capture step (PayPal Orders v2). */
    captureStep: boolean;
    /** Can create its own webhook endpoint via API (Razorpay: no). */
    autoWebhookRegister: boolean;
    /** Emits a native period-advance event (PayPal: no). */
    periodRotationEvents: boolean;
    /**
     * Signature check calls the provider's API (PayPal). Drives the
     * pipeline's CENTRALIZED test-skip: only online verification is skipped
     * under NODE_ENV=test — offline HMAC providers verify even in tests
     * (tests sign their fixtures).
     */
    onlineVerify: boolean;
    /**
     * Whether the provider can apply an ad-hoc, per-checkout coupon discount.
     * Split by flow because these are genuinely different API surfaces: a
     * provider whose one-off charge amount is ours to set discounts that
     * trivially, and may still have no way to take a single-period discount
     * on a recurring subscription (PayPal, Razorpay — see their descriptors).
     *
     * OPTIONAL, and absent means **cannot**. The field postdates the three
     * built-in modules and the contract is on its way to third parties
     * (`@rekey.dev/provider-kit`, see the spec's v2 section), so a module that
     * says nothing must not be handed a discount it will silently drop and
     * bill full price for. Fail-closed here costs a refused checkout;
     * fail-open costs the buyer money.
     */
    /**
     * Whether the provider can start a subscription in a free trial that it
     * converts to a charge on its own.
     *
     * OPTIONAL, and absent means **cannot**, for the same reason as
     * `discounts`: a module that says nothing must not be handed a trial it
     * will silently drop. Dropping one charges the buyer today for something
     * the pricing page told them was free for fourteen days — a chargeback and
     * a support ticket, not a rendering bug.
     *
     * Not split by flow: a trial only makes sense on a recurring subscription.
     * There is nothing for a one-off charge to convert into.
     */
    trials?: boolean;
    discounts?: {
      /** One-off charges — CREDIT packs and perpetual LICENSE purchases. */
      oneTime: boolean;
      /** A FIRST-PERIOD-ONLY discount on a recurring subscription. */
      recurring: boolean;
    };
  };
  credentialSchema: CredentialField[];
  /** Escape hatch for cross-field rules the declarative schema can't express. */
  validateCredentials?(creds: Record<string, string>): void;
  /**
   * Read the sandbox/live mode OUT OF THE KEY MATERIAL itself (Stripe
   * `sk_live_`/`sk_test_`, Razorpay `rzp_live_`/`rzp_test_`).
   *
   * Tri-state on purpose:
   *   - `'test'` / `'live'` — the credential says which it is. **Authoritative.**
   *     `credentials.service` stores this and rejects any contradicting
   *     operator-supplied label; an operator cannot relabel a live key as
   *     test, because the label is not what the provider SDK reads — the key
   *     is. A label allowed to disagree with the key would make everything
   *     downstream of `mode` a lie: the panel's test/live badge, the revenue
   *     stats, dunning, and PayPal's sandbox-vs-live base-URL choice.
   *   - `null` — the shape carries no marker and we genuinely cannot tell.
   *     Only then does an explicit `mode` decide, defaulting to `'test'`.
   *
   * Omit the hook entirely when the provider's credentials never carry a
   * marker (PayPal: a sandbox client id is indistinguishable from a live one).
   * Returning `'test'` for "unrecognised" would be a lie with teeth — it is
   * exactly the conflation that let a live key be stored as test.
   */
  detectMode?(creds: Record<string, string>): 'test' | 'live' | null;
  // NO `createProvider` here. The spec sketched one so a module could own its
  // outbound construction too, but the switch in providers/index.ts
  // (`getProviderForApplication`) was never migrated onto it, so all three
  // implementations sat unreachable for the life of the contract — a second,
  // silently-diverging way to build a provider. If the factory is ever moved
  // into the modules, add it back then, with a call site.
  webhook: {
    resolveApplication(req: RawWebhookReq): AppRef;
    /** Async → covers PayPal's online verify. Skipping is the PIPELINE's call. */
    verify(req: RawWebhookReq, creds: Record<string, string>, ctx: VerifyCtx): Promise<VerifyResult>;
    /**
     * The provider event id used for durable idempotency. `req` is provided
     * for providers whose id rides outside the payload (Razorpay's
     * `x-razorpay-event-id` header); payload-envelope providers ignore it.
     */
    extractEventId(payload: unknown, req?: RawWebhookReq): string;
    /**
     * The provider's own event-type string, persisted to
     * `webhook_events.event_type` for storage parity with the bespoke
     * routes. (Contract addition over the spec: the spec's pipeline needs
     * it for the idempotency insert but didn't name it.)
     */
    extractEventType(payload: unknown): string;
    /** null = unhandled event type (logged + acked, receipt marked). */
    translate(payload: unknown, ctx: TranslateCtx): DomainBillingEvent[] | null;
  };
}
