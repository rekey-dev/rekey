/**
 * BillingProvider interface — the seam between Rekey's domain shape and
 * each upstream payment processor.
 *
 * The contract expresses the **intersection** of what we'll support across
 * Stripe / PayPal / Razorpay. Provider-specific data (Stripe `price_*`,
 * PayPal plan id, Razorpay subscription id, …) lives in `metadata: Json`
 * on `Plan` / `Subscription` / `Payment`. Resist surfacing provider-only
 * concepts as top-level columns.
 *
 * The only implementations are the real ones — `RealStripeProvider`,
 * `RealPaypalProvider`, `RealRazorpayProvider` — built from the Application's
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
 * exactly the bug this field exists to fix — the buyer paid full price while
 * Rekey stamped `discountAmount` on the Subscription and burned a redemption.
 * `resolveCheckoutDiscount` refuses the checkout up front for any provider
 * whose module does not declare `capabilities.discounts`, so a module that
 * predates this never receives one.
 */
export interface CheckoutDiscount {
  /**
   * Amount off in the smallest currency unit, already resolved against the
   * plan — a PERCENT coupon is computed by `couponsService` and reaches the
   * provider as money, never as a percentage. Always `0 < amount <= plan.amount`.
   */
  amount: number;
  /** Currency of `amount` — always the plan's, ISO 4217 as stored. */
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
 * The methods every BillingProvider must implement. Synchronous failures
 * should throw `RekeyError` with a `BILLING_*` code; asynchronous state
 * changes (subscription activated, payment succeeded) flow through the
 * webhook ingress, not this interface.
 */
export interface BillingProvider {
  /** Stable identifier — `"stripe"`, `"paypal"`, `"razorpay"`. */
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
   * Mint a hosted ONE-TIME checkout — a single charge, no recurring billing.
   * Used for CREDIT packs and perpetual (non-TIMED) LICENSE purchases. Same
   * return shape; the difference is the provider charges once. Fulfillment
   * (credit grant / license issue) still lands via the webhook handler when
   * payment completes.
   *
   * Same rule for `input.discount`: apply it to the single charge, or throw.
   */
  createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult>;

  /**
   * Capture an approved one-time order (PayPal Orders v2 only — Stripe/Razorpay
   * one-time flows auto-capture). Optional: providers that don't need an
   * explicit capture step omit it. Idempotent.
   */
  captureOneTime?(providerOrderId: string): Promise<{ captured: boolean }>;

  /**
   * Create (or reuse) a webhook endpoint at `publicUrl` subscribed to the
   * events this provider's handler consumes, so operators don't paste the
   * secret/id by hand. Returns the provider-side identifiers to persist:
   *   - `secret`    — signing secret (Stripe `whsec_…`; verification key).
   *   - `webhookId` — provider webhook id (PayPal; needed to verify signatures).
   * Idempotent: a re-register of the same URL returns the existing endpoint.
   * Optional — providers without a create-webhook API (Razorpay) omit it.
   */
  registerWebhook?(publicUrl: string): Promise<{ secret?: string; webhookId?: string }>;

  /** Cancel a subscription. Default = at period end. */
  cancelSubscription(input: CancelSubscriptionInput): Promise<void>;
}
