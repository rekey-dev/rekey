/**
 * Razorpay billing provider — real implementation backed by the `razorpay` npm
 * package (Subscriptions API).
 *
 * Mode (`test` vs `live`) is implicit in the keyId prefix (`rzp_test_` /
 * `rzp_live_`); the SDK doesn't take a separate mode flag — it uses whichever
 * key you pass.
 *
 * Webhook verification uses HMAC-SHA256 of the raw body with the webhook
 * secret — see modules/razorpay/index.ts (the ProviderModule).
 *
 * There is NO stub. Missing credentials throw
 * `BILLING_CREDENTIALS_NOT_CONFIGURED` in every environment, dev included — the
 * stub providers were deleted precisely because "no payment processor
 * configured" silently succeeding everywhere but production is the opposite of
 * what a billing system should do. Tests substitute the fakes in
 * `test/fakes/billing-providers.ts` via a module mock in `test/setup.ts`.
 */

import { randomUUID } from 'node:crypto';
import Razorpay from 'razorpay';
import type { Plan } from '@prisma/client';
import type {
  BillingProvider,
  CancelSubscriptionInput,
  CheckoutSessionInput,
  CheckoutSessionResult,
  ProviderPlanRef,
  RefundPaymentInput,
  RefundPaymentResult,
} from './types.js';
import { discountUnsupported } from './discount.js';
import { RekeyError } from '../../../lib/error.js';
import type { RazorpayCredentials } from '../credentials.service.js';

/**
 * Hard ceiling on any outbound Razorpay call. Same 10s budget as the PayPal
 * provider and the OAuth exchanges.
 *
 * The SDK builds its own axios instance and passes no `timeout`, so axios's
 * default of `0` — wait forever — applied to every call in this class. A
 * wedged api.razorpay.com held the operator's request open indefinitely.
 */
const RAZORPAY_TIMEOUT_MS = 10_000;

/**
 * Shape of the SDK internals we reach into below. Not exported by the
 * package; declared here so the reach is typed rather than an `any` cast.
 */
interface RazorpayInternals {
  api?: { rq?: { defaults?: { timeout?: number } } };
}

export class RealRazorpayProvider implements BillingProvider {
  readonly name = 'razorpay';
  private readonly client: Razorpay;

  constructor(creds: RazorpayCredentials) {
    this.client = new Razorpay({
      key_id: creds.keyId,
      key_secret: creds.keySecret,
    });
    // The constructor accepts only key_id / key_secret / oauthToken / headers
    // (razorpay@2.9.6 dist/razorpay.js), so there is NO supported way to pass
    // a request timeout. Set the default on the axios instance the SDK stored,
    // which is the only thing that actually cancels the socket.
    //
    // Guarded rather than asserted: if a future SDK version moves or renames
    // this, the optional chain leaves the default in place and `withTimeout`
    // below still releases OUR handler. Bump this file if the SDK grows a
    // real option.
    const internals = this.client as unknown as RazorpayInternals;
    if (internals.api?.rq?.defaults) {
      internals.api.rq.defaults.timeout = RAZORPAY_TIMEOUT_MS;
    }
  }

  /**
   * Belt to the axios braces above: reject after the deadline whatever the SDK
   * is doing. This does not free the socket — only the axios timeout does
   * that — but it guarantees the caller's request handler is never pinned by a
   * provider call, which is the failure that matters at the API boundary.
   */
  private withTimeout<T>(work: Promise<T>, op: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Razorpay ${op} exceeded ${RAZORPAY_TIMEOUT_MS}ms`)),
        RAZORPAY_TIMEOUT_MS + 500,
      );
      timer.unref();
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  }

  async ensurePlanRegistered(plan: Plan): Promise<ProviderPlanRef> {
    const period = plan.interval === 'YEAR' ? 'yearly' : 'monthly';
    // Razorpay needs amount in the smallest currency unit (paise for INR,
    // cents for USD) — same as ours, so no conversion.
    const created = await this.withTimeout(
      this.client.plans.create({
        period,
        interval: 1,
        item: {
          name: plan.name,
          amount: plan.amount,
          currency: plan.currency,
        },
        notes: { rekey_plan_id: plan.id, rekey_slug: plan.slug },
      }),
      'plans.create',
    );
    return { providerPlanId: (created as { id: string }).id };
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    if (input.discount) {
      // A Razorpay subscription bills straight off the plan. The only discount
      // surface is an Offer (`offer_id`), created in the dashboard rather than
      // through the API and never per-checkout; `addons` only ADD to a cycle.
      // There is no honest way to take an ad-hoc amount off one period, so the
      // coupon is refused rather than silently billed at full price.
      // `checkout-discount.ts` normally refuses first — this is the backstop.
      throw discountUnsupported(this.name, 'recurring');
    }
    const meta = (input.plan.metadata as Record<string, unknown> | null) ?? {};
    const rzpMeta = (meta.razorpay as { planId?: string } | undefined) ?? {};
    let rzpPlanId = rzpMeta.planId;
    if (!rzpPlanId) {
      rzpPlanId = (await this.ensurePlanRegistered(input.plan)).providerPlanId;
    }

    // Razorpay Subscription create. `total_count: 12` = 12 billing cycles
    // (Razorpay requires a finite count for subscriptions API). For an
    // indefinite sub we pick a large number; the operator can cancel any time.
    const sub = await this.withTimeout(
      this.client.subscriptions.create({
        plan_id: rzpPlanId,
        total_count: input.plan.interval === 'YEAR' ? 10 : 120,
        customer_notify: 1,
        notes: {
          rekey_end_user_id: input.endUser.id,
          rekey_plan_id: input.plan.id,
        },
      }),
      'subscriptions.create',
    );
    // Razorpay returns a `short_url` users hit to authorize. Wrap with our
    // success/cancel via `callback_url` style — Razorpay doesn't natively
    // support cancel/return URLs on subscriptions, so we encode them in
    // notes for the integrator's frontend to read on redirect-back.
    const subTyped = sub as { id: string; short_url: string };
    return { url: subTyped.short_url, sessionId: subTyped.id };
  }

  /**
   * One-time purchase via a Razorpay Payment Link (single charge, no
   * subscription). Returns the hosted `short_url`. Fulfillment lands on the
   * `payment_link.paid` webhook (modules/razorpay translate → apply.ts).
   *
   * A payment link has no discount field — the amount is ours to name — so a
   * coupon IS the smaller amount. That charges correctly but loses the reason,
   * which is why the code goes into `notes`: the operator opening the link in
   * their Razorpay dashboard needs to see why it is not the plan price.
   */
  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    // The razorpay SDK's paymentLink.create types are over-strict (demand
    // options/customer) and its return type is noisy — cast to a loose
    // signature, same posture as plans/subscriptions create above.
    const create = this.client.paymentLink.create as (body: unknown) => Promise<unknown>;
    const link = (await this.withTimeout(
      create({
        amount: input.plan.amount - (input.discount?.amount ?? 0),
        currency: input.plan.currency,
        accept_partial: false,
        description: input.plan.name,
        callback_url: input.successUrl,
        callback_method: 'get',
        notes: {
          rekey_application_id: input.application.id,
          rekey_end_user_id: input.endUser.id,
          rekey_plan_id: input.plan.id,
          ...(input.discount && {
            rekey_coupon_code: input.discount.code,
            rekey_discount_amount: String(input.discount.amount),
          }),
        },
      }),
      'paymentLink.create',
    )) as { id: string; short_url: string };
    return { url: link.short_url, sessionId: link.id };
  }

  /**
   * Refund a captured Razorpay payment.
   *
   * The id must be a `pay_…` in `captured` state. There is no standalone
   * `POST /v1/refunds` — `/v1/refunds` is read-only — and an `order_…` cannot
   * be refunded. Our column already holds `payment.id` for every Razorpay
   * event (`modules/razorpay/index.ts`), so the stored id is the right one,
   * which is not true of Stripe.
   *
   * Two things about the result are easy to get wrong:
   *
   * 1. **The create response is not the outcome.** Razorpay creates every
   *    refund `pending` and reports the real result later on the
   *    `refund.processed` / `refund.failed` webhooks. Reporting `pending` here
   *    is therefore the normal, successful path and not a degraded one.
   * 2. **Razorpay does not return its fee.** The MDR and its 18% GST on the
   *    original capture are NOT reversed by a refund, so a refunded payment
   *    still costs the operator money. That is a real input to
   *    refund-versus-extend and belongs in front of the operator, not here.
   */
  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    // Idempotency via `receipt`, which Razorpay scopes per payment and refuses
    // on reuse ("Duplicate receipt found for this refund request."). Razorpay
    // also documents an `X-Refund-Idempotency` HEADER, which is the better
    // mechanism — it replays the original result instead of erroring — but
    // razorpay@2.9.6 takes headers only on the constructor, and an idempotency
    // key must vary per request. Switch to the header if the SDK grows a
    // per-call option; until then `receipt` is what this SDK can actually
    // carry, and it does stop a double refund.
    let refund: { id?: string; amount?: number; currency?: string; status?: string };
    try {
      refund = (await this.withTimeout(
        this.client.payments.refund(input.providerPaymentId, {
          // Absent = Razorpay refunds the full remaining amount. Amounts are
          // already in the smallest unit on both sides, so no conversion.
          ...(input.amount !== undefined && { amount: input.amount }),
          receipt: input.idempotencyKey.slice(0, 40),
          ...(input.reason && { notes: { rekey_reason: input.reason.slice(0, 255) } }),
        }),
        'payments.refund',
      )) as typeof refund;
    } catch (e) {
      const text = (e as { error?: { description?: string } })?.error?.description ?? String(e);
      // Razorpay states this limit as "6 months" and never as a day count, so
      // the message says months too rather than inventing a precision the
      // provider does not publish.
      if (text.includes('more than 6 months old')) {
        throw new RekeyError({
          statusCode: 409,
          code: 'BILLING_REFUND_WINDOW_CLOSED',
          message: 'Razorpay will not refund a payment more than 6 months old.',
          fix: 'Razorpay cannot move this money back. Settle it with the buyer another way, or extend their entitlements instead and resolve the case that way.',
        });
      }
      if (text.includes('Duplicate receipt found')) {
        throw new RekeyError({
          statusCode: 409,
          code: 'BILLING_REFUND_ALREADY_REQUESTED',
          message: 'This exact refund has already been sent to Razorpay.',
          fix: 'Nothing to do — a second one would pay the buyer twice. Check the payment in the Razorpay dashboard for the outcome; it arrives on the `refund.processed` webhook.',
        });
      }
      throw new RekeyError({
        statusCode: 502,
        code: 'BILLING_REFUND_REJECTED',
        message: `Razorpay refused the refund: ${text}`,
        fix: 'Check the payment in the Razorpay dashboard. A payment that was never captured, or whose source cannot take the money back (some UPI and NRE accounts), has to be settled with the buyer another way.',
      });
    }
    return {
      refundId: refund.id ?? input.idempotencyKey,
      amount: refund.amount ?? input.amount ?? 0,
      currency: (refund.currency ?? input.currency ?? 'INR').toUpperCase(),
      // `processed` is the only terminal success. `pending` is the usual
      // answer here and the webhook carries the real one.
      status: refund.status === 'processed' ? 'succeeded' : 'pending',
    };
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
    const providerSubId = input.subscription.providerSubId;
    if (!providerSubId) return;
    // The second argument is razorpay-node's `cancelAtCycleEnd`, which it
    // turns into `cancel_at_cycle_end: 1` when truthy
    // (razorpay@2.9.6 dist/resources/subscriptions.js). It means the same
    // thing as our `atPeriodEnd`, so it takes the same value.
    //
    // It used to be NEGATED, and the two arguments cancel out to read almost
    // plausibly, which is how it survived: "cancel at period end" sent
    // `cancel_at_cycle_end: 0` and Razorpay terminated the subscription on the
    // spot, mid-period, while Rekey's own row stayed ACTIVE with a `cancelAt`
    // in the future — the buyer lost the time they had paid for and the portal
    // told them they still had it. "Cancel immediately" did the reverse and
    // left them billed for another cycle. This is the same defect PR #336
    // fixed on the provider-less path, one provider over, and no test could
    // see it: the suite's fake provider records the call and never asks
    // Razorpay what it meant.
    const cancelAtCycleEnd = input.atPeriodEnd !== false;
    await this.withTimeout(
      this.client.subscriptions.cancel(providerSubId, cancelAtCycleEnd),
      'subscriptions.cancel',
    );
  }
}
