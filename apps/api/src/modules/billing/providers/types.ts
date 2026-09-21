/**
 * BillingProvider interface, the seam between Rekey's domain shape and
 * each upstream payment processor.
 *
 * The contract expresses the **intersection** of what we'll support across
 * Stripe / PayPal / Razorpay. Provider-specific data (Stripe `price_*`,
 * PayPal plan id, Razorpay subscription id, …) lives in `metadata: Json`
 * on `Plan` / `Subscription` / `Payment`. Resist surfacing provider-only
 * concepts as top-level columns.
 *
 * The only implementations are the real ones, `RealStripeProvider`,
 * `RealPaypalProvider`, `RealRazorpayProvider`, built from the Application's
 * BYO credentials. There is no stub: without credentials `providers/index.ts`
 * throws `BILLING_CREDENTIALS_NOT_CONFIGURED`. Tests supply their own fakes
 * from `test/fakes/billing-providers.ts`.
 */

import type { Plan, EndUser, Subscription } from '@prisma/client';

/** A provider-side identifier (Stripe `price_*`, PayPal plan id, etc.). */
export interface ProviderPlanRef {
  /** Stable provider id we store back into Plan.metadata. */
  providerPlanId: string;
}

/**
 * A validated coupon discount to apply to ONE checkout, resolved by
 * `billing/checkout-discount.ts` before the provider is built.
 *
 * It is optional on `CheckoutSessionInput` so provider implementations written
 * before coupons reached the provider keep compiling. That is a courtesy to
 * the compiler and nothing more: a provider that cannot apply the discount
 * must THROW (`discountUnsupported`), never quietly drop it. Dropping it is
 * exactly the bug this field exists to fix, the buyer paid full price while
 * Rekey stamped `discountAmount` on the Subscription and burned a redemption.
 * `resolveCheckoutDiscount` refuses the checkout up front for any provider
 * whose module does not declare `capabilities.discounts`, so a module that
 * predates this never receives one.
 */
export interface CheckoutDiscount {
  /**
   * Amount off in the smallest currency unit, already resolved against the
   * plan, a PERCENT coupon is computed by `couponsService` and reaches the
   * provider as money, never as a percentage. Always `0 < amount <= plan.amount`.
   */
  amount: number;
  /** Currency of `amount`, always the plan's, ISO 4217 as stored. */
  currency: string;
  /** Rekey `Coupon.id`, for the provider's own records where it takes them. */
  couponId: string;
  /** The coupon code as stored (lowercase), for the provider-side label. */
  code: string;
}

export interface CheckoutSessionInput {
  application: { id: string; slug: string };
  endUser: EndUser;
  plan: Plan;
  /** Where the customer's site wants the user sent on success / cancellation. */
  successUrl: string;
  cancelUrl: string;
  /** Coupon discount to apply to this checkout. Absent = charge full price. */
  discount?: CheckoutDiscount;
  /**
   * Free trial to start this subscription in. Absent = charge immediately.
   * Only ever set for a provider whose module declares `capabilities.trials`,
   * see checkout-trial.ts.
   */
  trial?: { days: number };
}

export interface CheckoutSessionResult {
  /** URL the browser should redirect to (provider-hosted checkout). */
  url: string;
  /** Provider's session id, persisted onto Subscription.metadata for reconciliation. */
  sessionId: string;
}

export interface CancelSubscriptionInput {
  subscription: Subscription;
  /** True = stop at period end (default). False = stop immediately. */
  atPeriodEnd?: boolean;
}

/**
 * One refund of one already-captured charge, issued by an operator.
 *
 * Refunding never cancels a subscription at any of the three providers, they
 * are separate calls everywhere, so a caller that wants both must make both.
 */
export interface RefundPaymentInput {
  /**
   * The provider's charge id, as stored on `Payment.providerPaymentId`.
   *
   * NOT uniformly refundable as stored. Stripe writes an INVOICE id here for
   * renewals and a Checkout Session id for the first payment, and the Refunds
   * API accepts neither, the Stripe implementation resolves those to a
   * PaymentIntent before refunding. PayPal writes the sale id, which is the
   * refundable one (a subscription id `I-…` is not refundable at all).
   */
  providerPaymentId: string;
  /**
   * Partial amount in the smallest currency unit. Omit for a full refund of
   * whatever remains unrefunded, which is what every provider does with an
   * absent amount, so an omitted amount is never a full-amount guess on our
   * part.
   */
  amount?: number;
  /** Currency of `amount`, ISO 4217. Required whenever `amount` is set. */
  currency?: string;
  /** Operator's reason. Surfaced to the buyer by providers that show one. */
  reason?: string;
  /**
   * Caller-supplied idempotency key, so an operator double-clicking "Refund",
   * or a retried request, cannot pay the same money back twice. Every provider
   * has a mechanism for this and all three are wired up.
   */
  idempotencyKey: string;
  /**
   * The provider's own refund URL, captured from the payment webhook.
   *
   * PayPal only, and preferred over `providerPaymentId` when present: PayPal
   * hands us a `rel:"refund"` href per transaction, which names the correct
   * endpoint AND API version for that specific payment. Using it sidesteps a
   * question PayPal's documentation does not answer, whether a subscription
   * sale id is accepted by the v2 captures endpoint (see the module).
   */
  refundHref?: string;
}

export interface RefundPaymentResult {
  /** The provider's refund id, for reconciliation against its webhooks. */
  refundId: string;
  /** Amount actually refunded, smallest currency unit. */
  amount: number;
  /** Currency of `amount`, ISO 4217. */
  currency: string;
  /**
   * Whether the money has actually moved.
   *
   * `pending` is not a failure and not a retry signal: Razorpay CREATES every
   * refund `pending` and reports the outcome later on `refund.processed`, and
   * PayPal returns `PENDING` for eCheck-funded refunds. A caller that treats
   * the create response as the outcome will mark refunds succeeded that later
   * failed, so the terminal answer comes from the webhook, not from here.
   */
  status: 'succeeded' | 'pending';
}

/**
 * One subscription as a provider reports it, normalised.
 *
 * Deliberately the smallest set that answers "who is entitled to what, until
 * when". No card data, no payment instrument, no invoice history, no addresses:
 * an import reads entitlement, and payments stay where they were taken. A
 * customer who wants payment rows in Rekey uses the push direction, which
 * already exists.
 *
 * Every field except the four required ones is optional, and unknown fields are
 * ignored, so the contract can grow without breaking an implementer.
 */
export interface ExternalSubscription {
  /**
   * The provider's own id. THE idempotency key for the whole feature:
   * re-importing the same id never creates a second subscription, so a
   * provider must never reuse one for a different subscription.
   */
  externalId: string;
  /** Anything outside this set is `skip_invalid` rather than a guess. */
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'expired';
  /** The provider's plan identifier, mapped to a local plan slug by the operator. */
  planRef: string;
  customer: {
    /** The match key. Absent means the row cannot be imported. */
    email: string;
    /** Stored on a created user, so a later run survives a renamed address. */
    externalId?: string | undefined;
    name?: string | undefined;
  };
  /** ISO 8601. Defaults to the import time. */
  startedAt?: string | undefined;
  /**
   * ISO 8601. Absent means open-ended, nothing expires it locally, and
   * cancelling it later takes effect immediately rather than at period end.
   */
  currentPeriodEnd?: string | undefined;
  cancelAt?: string | null | undefined;
  /**
   * ISO 8601. When the trial a `trialing` row is on ends. A future value is
   * judged by the trial ledger under the Application's `trialPolicy`: honoured,
   * the row is imported TRIALING; refused, it is imported ACTIVE without the
   * trial and the run says so. Absent or past, the row is imported ACTIVE,
   * there is no clock to run.
   */
  trialEndsAt?: string | null | undefined;
  /** Defaults to 1. Feeds licence seats where the plan carries a LICENSE entitlement. */
  quantity?: number | undefined;
  /** Opaque, stored on the subscription. Subject to the existing metadata ceiling. */
  metadata?: Record<string, unknown> | undefined;
}

/**
 * The methods every BillingProvider must implement. Synchronous failures
 * should throw `RekeyError` with a `BILLING_*` code; asynchronous state
 * changes (subscription activated, payment succeeded) flow through the
 * webhook ingress, not this interface.
 */
export interface BillingProvider {
  /** Stable identifier, `"stripe"`, `"paypal"`, `"razorpay"`. */
  readonly name: string;

  /**
   * Bootstrap a provider-side Plan record from our local Plan row. Called
   * by the admin "create plan" flow. Stripe creates a `Product` + `Price`;
   * PayPal creates a `Plan`; Razorpay creates a `Plan`. Returns the
   * provider id we store back into `Plan.metadata`.
   */
  ensurePlanRegistered(plan: Plan): Promise<ProviderPlanRef>;

  /**
   * Mint a hosted-checkout session for a RECURRING subscription. Returns a
   * URL to redirect the user to. Activation lands via the webhook handler.
   *
   * `input.discount`, when present, MUST be applied to the first billing
   * period or the call must throw. Ignoring it charges full price against a
   * discount Rekey has already recorded.
   */
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult>;

  /**
   * Mint a hosted ONE-TIME checkout, a single charge, no recurring billing.
   * Used for CREDIT packs and perpetual (non-TIMED) LICENSE purchases. Same
   * return shape; the difference is the provider charges once. Fulfillment
   * (credit grant / license issue) still lands via the webhook handler when
   * payment completes.
   *
   * Same rule for `input.discount`: apply it to the single charge, or throw.
   */
  createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult>;

  /**
   * Capture an approved one-time order (PayPal Orders v2 only, Stripe/Razorpay
   * one-time flows auto-capture). Optional: providers that don't need an
   * explicit capture step omit it. Idempotent.
   */
  captureOneTime?(providerOrderId: string): Promise<{ captured: boolean }>;

  /**
   * Create (or reuse) a webhook endpoint at `publicUrl` subscribed to the
   * events this provider's handler consumes, so operators don't paste the
   * secret/id by hand. Returns the provider-side identifiers to persist:
   *   - `secret`   , signing secret (Stripe `whsec_…`; verification key).
   *   - `webhookId`, provider webhook id (PayPal; needed to verify signatures).
   * Idempotent: a re-register of the same URL returns the existing endpoint.
   * Optional, providers without a create-webhook API (Razorpay) omit it.
   */
  registerWebhook?(publicUrl: string): Promise<{ secret?: string; webhookId?: string }>;

  /** Cancel a subscription. Default = at period end. */
  cancelSubscription(input: CancelSubscriptionInput): Promise<void>;

  /**
   * Page through the subscriptions this provider already knows about, so an
   * operator can import a book of business Rekey never sold.
   *
   * OPTIONAL, and absent means **cannot**, the same fail-closed posture as
   * `refundPayment` and `capabilities.discounts`. A provider with no list API
   * says nothing here, and the panel learns the import is unavailable from the
   * method being missing rather than from an operator pressing a button and
   * getting an exception.
   *
   * Read-only and side-effect free BY CONTRACT: Rekey calls it repeatedly,
   * including for dry runs that write nothing.
   */
  listSubscriptions?(input: {
    /** Opaque; echo whatever paginates the source. Absent on the first page. */
    cursor?: string | undefined;
    /** Rows per page. Rekey asks for 1..200. */
    limit: number;
  }): Promise<{ items: ExternalSubscription[]; nextCursor?: string | undefined }>;

  /**
   * Pay a captured charge back to the buyer.
   *
   * OPTIONAL, and absent means **cannot**, same fail-closed posture as
   * `capabilities.discounts` and `capabilities.trials`. A provider that has no
   * refund API must say nothing here rather than throw at the moment an
   * operator presses the button, because the operator needs to learn that
   * before they promise a customer their money back. `capabilities.refunds` is
   * the declaration the UI reads; this method is what it promises.
   *
   * Throws `RekeyError` when the provider refuses. The common refusals are
   * worth distinguishing in the UI because their remedies differ: the charge
   * is too old (every provider has a window), it is already fully refunded, or
   * the requested amount exceeds what remains.
   */
  refundPayment?(input: RefundPaymentInput): Promise<RefundPaymentResult>;
}
