/**
 * Real Stripe BillingProvider, uses the official `stripe` SDK with the
 * Application's BYO API key.
 *
 * Picked by `getProviderForApplication` when the Application has BYO Stripe
 * credentials (apiKey + webhookSecret). Without them the factory throws
 * `BILLING_CREDENTIALS_NOT_CONFIGURED`, there is no fallback.
 *
 * Tests don't call this against api.stripe.com; they substitute a fake from
 * `test/fakes/billing-providers.ts`. To exercise this class for real, set up
 * a Stripe test account, configure BYO via the panel, and run end-to-end.
 */

import type Stripe from 'stripe';
import { RekeyError } from '../../../lib/error.js';
import { STRIPE_API_VERSION } from './stripe-api-version.js';
import { createStripeClient } from './stripe-client.js';
import { paidInvoicePayments, type StripeRefundTarget } from './stripe-invoice-payments.js';
import { paymentPurchase, stripePriceIdFor, subscriptionPurchase } from './stripe-session-params.js';
import { embeddedSessionParams, requirePublishableKey, retrieveCheckoutSnapshot } from './stripe-embedded.js';
import { replaceWithHostedSession } from './stripe-hosted-fallback.js';
import type {
  BillingProvider,
  CancelSubscriptionInput,
  CheckoutDiscount,
  CheckoutSessionInput,
  CheckoutSessionResult,
  EmbeddedCheckoutInput,
  EmbeddedCheckoutResult,
  HostedFallbackInput,
  ProviderCheckoutSessionSnapshot,
  ProviderPlanRef,
  RefundPaymentInput,
  RefundPaymentResult,
} from './types.js';
import type { Plan } from '@prisma/client';

interface RealStripeCreds {
  apiKey: string;
  webhookSecret: string;
  /** Only the Rekey checkout page needs it; blank on credentials saved before it existed. */
  publishableKey?: string;
}

/**
 * How long an ad-hoc checkout Coupon stays redeemable.
 *
 * A Stripe Checkout Session expires about 24h after creation, so anything
 * much longer only leaves usable discount objects behind in the operator's
 * account after the buyer walked away. The extra hour is deliberate: at
 * exactly 24h the coupon and the session it belongs to expire at the same
 * moment, and the loser of that race is a buyer who came back at the last
 * minute and had their payment refused by a coupon that had just died. The
 * session is what should time a checkout out, not the discount attached to
 * it.
 */
const CHECKOUT_COUPON_TTL_SECONDS = 25 * 60 * 60;

export class RealStripeProvider implements BillingProvider {
  readonly name = 'stripe';
  private readonly stripe: Stripe;

  constructor(private readonly creds: RealStripeCreds) {
    this.stripe = createStripeClient(creds.apiKey);
  }

  /**
   * Per-app webhook secret. UNUSED by the webhook path, which reads
   * `webhookSecret` straight off the decrypted credential row
   * (`webhooks/pipeline.ts` → `loadDecryptedWithMode`) rather than constructing a
   * provider. Retained only so this class stays shape-compatible with the test
   * fake in `test/fakes/billing-providers.ts`.
   */
  getWebhookSecret(): string {
    return this.creds.webhookSecret;
  }

  /**
   * Create a Stripe Product + Price for this Plan if not already
   * registered, then return the Price id we'll reference at checkout.
   *
   * Idempotency: we check `Plan.metadata.stripe.priceId` first; if
   * present, return it without hitting Stripe. The very first call mints
   * both Product and Price.
   */
  async ensurePlanRegistered(plan: Plan): Promise<ProviderPlanRef> {
    const existing = (plan.metadata as { stripe?: { priceId?: string } } | null)?.stripe?.priceId;
    if (existing) return { providerPlanId: existing };

    const product = await this.stripe.products.create({
      name: plan.name,
      metadata: {
        rekeyPlanId: plan.id,
        rekeyApplicationId: plan.applicationId,
      },
    });

    const price = await this.stripe.prices.create({
      product: product.id,
      unit_amount: plan.amount,
      currency: plan.currency.toLowerCase(),
      recurring: {
        interval: plan.interval === 'YEAR' ? 'year' : 'month',
      },
      metadata: {
        rekeyPlanId: plan.id,
      },
    });

    return { providerPlanId: price.id };
  }

  /**
   * Mint a one-shot Stripe Coupon for this checkout and return the
   * `discounts` array a Checkout Session takes. Both modes accept it,
   * `payment` applies it to the session total, `subscription` to the invoice.
   *
   * `amount_off`, never `percent_off`. Rekey has already resolved a PERCENT
   * coupon against the plan and written that integer to
   * `Subscription.metadata.discountAmount` (and it is what the operator sees
   * in the coupon stats). Handing Stripe the percentage instead lets it
   * recompute against its own base, proration, tax, and what the buyer is
   * charged silently stops matching what we recorded and redeemed.
   *
   * `duration: 'once'` for the same reason exactly one redemption is
   * recorded: the code buys the first invoice, not every invoice. `'forever'`
   * would hand out a permanent price cut our books never knew about.
   *
   * Minted per checkout and capped, `max_redemptions: 1` plus a short
   * `redeem_by`, so an abandoned checkout cannot leave a live, reusable
   * discount sitting in the operator's Stripe account.
   */
  private async createDiscount(
    discount: CheckoutDiscount,
  ): Promise<{ discounts: Stripe.Checkout.SessionCreateParams.Discount[]; couponId: string }> {
    let coupon: Stripe.Coupon;
    try {
      coupon = await this.stripe.coupons.create({
        amount_off: discount.amount,
        currency: discount.currency.toLowerCase(),
        duration: 'once',
        name: discount.code,
        max_redemptions: 1,
        redeem_by: Math.floor(Date.now() / 1000) + CHECKOUT_COUPON_TTL_SECONDS,
        metadata: {
          rekeyCouponId: discount.couponId,
          rekeyCouponCode: discount.code,
        },
      });
  } catch {
      // Stripe refusing the coupon is a coupon problem, and it is the buyer
      // who is standing in front of it. Left raw it surfaced as an opaque 500
      //, indistinguishable from Rekey being down, so the one thing the
      // caller could act on (drop the code and buy at full price) never
      // reached them.
      throw new RekeyError({
        statusCode: 502,
        code: 'COUPON_PROVIDER_REJECTED',
        message: `The payment provider would not create a discount for coupon "${discount.code}".`,
        fix: 'Retry the checkout without the coupon, or check the operator Stripe account for restrictions on the currency or amount.',
      });
    }
    return { discounts: [{ coupon: coupon.id }], couponId: coupon.id };
  }

  /**
   * Delete an ad-hoc coupon whose Checkout Session was never created.
   *
   * Ad-hoc coupons are minted BEFORE the session, because the session takes
   * the coupon id, so a session that fails to create leaves a live, usable
   * discount object behind that nothing will ever reference. Best-effort: the
   * checkout has already failed and the caller's error is the one worth
   * reporting, so a failed cleanup must not replace it.
   *
   * Abandonment by the BUYER (session created, never paid) is not cleaned up
   * here and deliberately so, the session may still be completed. Those
   * coupons are bounded instead by `max_redemptions: 1` and `redeem_by`.
   */
  private async discardDiscount(couponId: string | undefined): Promise<void> {
    if (!couponId) return;
    try {
      await this.stripe.coupons.del(couponId);
    } catch {
      /* best-effort */
    }
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const priceId = stripePriceIdFor(input);
    const session = await this.withDiscount(input, (discounts) =>
      this.stripe.checkout.sessions.create({
        ...subscriptionPurchase(input, priceId, discounts),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      }),
    );
    if (!session.url) throw new Error('Stripe returned a checkout session without a `url`.');
    return { sessionId: session.id, url: session.url };
  }

  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    // `checkout.session.completed` fires on success and the webhook handler
    // grants credits / issues the license by plan.kind.
    const session = await this.withDiscount(input, (discounts) =>
      this.stripe.checkout.sessions.create({
        ...paymentPurchase(input, discounts),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      }),
    );
    if (!session.url) throw new Error('Stripe returned a one-time checkout session without a `url`.');
    return { sessionId: session.id, url: session.url };
  }

  /**
   * Mint the checkout's coupon, create the session with it, and delete the
   * coupon again when no usable session came back.
   */
  private async withDiscount(
    input: CheckoutSessionInput,
    create: (discounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined) => Promise<Stripe.Checkout.Session>,
  ): Promise<Stripe.Checkout.Session> {
    const minted = input.discount ? await this.createDiscount(input.discount) : undefined;
    let session: Stripe.Checkout.Session;
    try {
      session = await create(minted?.discounts);
    } catch (e) {
      await this.discardDiscount(minted?.couponId);
      throw e;
    }
    const usable = session.ui_mode === 'elements' ? session.client_secret : session.url;
    if (!usable) await this.discardDiscount(minted?.couponId);
    return session;
  }

  /**
   * The same Checkout Session as `createCheckoutSession` /
   * `createOneTimeCheckout`, in `ui_mode: 'elements'` for the Rekey page.
   *
   * @example
   * const { client } = await provider.createEmbeddedCheckout({ ...input, kind: 'recurring', returnUrl });
   */
  async createEmbeddedCheckout(input: EmbeddedCheckoutInput): Promise<EmbeddedCheckoutResult> {
    const publishableKey = requirePublishableKey(this.creds.publishableKey);
    const priceId = input.kind === 'recurring' ? stripePriceIdFor(input) : null;
    const session = await this.withDiscount(input, (discounts) =>
      this.stripe.checkout.sessions.create(embeddedSessionParams(input, priceId, discounts)),
    );
    if (!session.client_secret) {
      throw new Error('Stripe returned an elements checkout session without a `client_secret`.');
    }
    return {
      sessionId: session.id,
      client: { provider: 'stripe', publishableKey, clientSecret: session.client_secret, sdk: 'elements' },
      fallbackUrl: null,
      providerPlanId: priceId,
    };
  }

  /** @example const snapshot = await provider.getCheckoutSession('cs_test_…'); */
  async getCheckoutSession(providerSessionId: string): Promise<ProviderCheckoutSessionSnapshot | null> {
    return retrieveCheckoutSnapshot(this.stripe, providerSessionId);
  }

  /** @example await provider.expireCheckoutSession('cs_test_…'); */
  async expireCheckoutSession(providerSessionId: string): Promise<void> {
    await this.stripe.checkout.sessions.expire(providerSessionId);
  }

  /** @example const { url } = await provider.createHostedFallback({ ...input, kind, embeddedSessionId, idempotencyKey, priceId, expiresAt }); */
  async createHostedFallback(input: HostedFallbackInput): Promise<CheckoutSessionResult> {
    return replaceWithHostedSession(this.stripe, input);
  }

  /**
   * Create a Stripe webhook endpoint at `publicUrl` subscribed to the events
   * our handler consumes, and return its signing secret. Stripe only reveals
   * the secret at creation time, so if an endpoint already points at this URL
   * we delete + recreate to obtain a storable secret.
   */
  async registerWebhook(publicUrl: string): Promise<{ secret?: string; webhookId?: string }> {
    const enabledEvents: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
      'checkout.session.completed',
      // Checkout offers whatever methods the account enables, and a delayed
      // one (bank debits, vouchers) completes the session unpaid. This is
      // when its money actually arrives.
      'checkout.session.async_payment_succeeded',
      // And when it does not: the checkout is closed so the buyer can start
      // another.
      'checkout.session.async_payment_failed',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed',
      'charge.refunded',
    ];
    const existing = await this.stripe.webhookEndpoints.list({ limit: 100 });
    const match = existing.data.find((e) => e.url === publicUrl);
    if (match) {
      await this.stripe.webhookEndpoints.del(match.id);
    }
    const created = await this.stripe.webhookEndpoints.create({
      url: publicUrl,
      api_version: STRIPE_API_VERSION,
      enabled_events: enabledEvents,
      description: 'Rekey (auto-configured)',
    });
    return { webhookId: created.id, ...(created.secret && { secret: created.secret }) };
  }

  /**
   * Resolve whatever we stored on `Payment.providerPaymentId` into something
   * the Refunds API will actually take.
   *
   * This step is not incidental. Stripe's Refunds API accepts a `charge` or a
   * `payment_intent` and NOTHING else, but the column holds four different id
   * kinds depending on which event wrote the row:
   *
   *   `pi_`, checkout.session.completed, when the session had one    (direct)
   *   `ch_`, never written today, but a charge id is refundable      (direct)
   *   `in_`, invoice.payment_succeeded, i.e. EVERY RENEWAL           (resolve)
   *   `cs_`, checkout.session.completed with no payment intent yet   (resolve)
   *
   * So the ids for renewals, the majority of payments any live application
   * has, are the ones the API rejects. Passing the stored id through
   * unexamined would refuse most real refunds with Stripe's own opaque
   * "No such payment_intent" rather than anything an operator could act on.
   *
   * Matched by PREFIX rather than against a list of known values, so an id
   * kind Stripe adds later fails as an unrecognised id instead of being
   * silently posted as a payment intent.
   */
  private async resolveRefundTarget(providerPaymentId: string): Promise<StripeRefundTarget> {
    if (providerPaymentId.startsWith('pi_')) return { payment_intent: providerPaymentId };
    if (providerPaymentId.startsWith('ch_')) return { charge: providerPaymentId };

    const unpaid = (kind: string) =>
      new RekeyError({
        statusCode: 409,
        code: 'BILLING_PAYMENT_NOT_REFUNDABLE',
        message: `This payment's Stripe ${kind} has no payment behind it, so there is nothing to refund.`,
        fix: 'Check the payment in the Stripe dashboard. A charge that never completed has nothing to pay back, and the money the operator is looking for is somewhere else.',
      });

    if (providerPaymentId.startsWith('in_')) {
      const { targets, outsideStripe } = await paidInvoicePayments(this.stripe, providerPaymentId);
      if (outsideStripe > 0) {
        throw new RekeyError({
          statusCode: 409,
          code: 'BILLING_PAYMENT_NOT_REFUNDABLE',
          message: "This payment's Stripe invoice was paid partly or wholly outside Stripe, so Stripe cannot refund it.",
          fix: 'Refund it from the invoice in the Stripe dashboard, and settle any part paid outside Stripe with the buyer directly.',
        });
      }
      const [only, ...rest] = targets;
      if (!only) throw unpaid('invoice');
      if (rest.length > 0) {
        throw new RekeyError({
          statusCode: 409,
          code: 'BILLING_PAYMENT_NOT_REFUNDABLE',
          message: `This payment's Stripe invoice was settled by ${targets.length} separate payments, so Rekey cannot tell which one to refund.`,
          fix: "Refund the right payment from the invoice in the Stripe dashboard. Rekey records each refunded charge's own running total against this payment and does not add separate charges together, so check its refunded amount in Rekey afterwards.",
        });
      }
      return only;
    }
    if (providerPaymentId.startsWith('cs_')) {
      const session = await this.stripe.checkout.sessions.retrieve(providerPaymentId);
      const pi = session.payment_intent;
      const id = typeof pi === 'string' ? pi : (pi?.id ?? null);
      if (!id) throw unpaid('checkout session');
      return { payment_intent: id };
    }
    throw new RekeyError({
      statusCode: 409,
      code: 'BILLING_PAYMENT_NOT_REFUNDABLE',
      message: `Rekey does not recognise "${providerPaymentId}" as a Stripe id it can refund.`,
      fix: 'Refund this one in the Stripe dashboard directly, and open an issue with the id, Rekey should have been able to resolve it.',
    });
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const target = await this.resolveRefundTarget(input.providerPaymentId);
    let refund: Stripe.Refund;
    try {
      refund = await this.stripe.refunds.create(
        {
          ...target,
          // Absent = Stripe refunds the full remaining amount itself.
          ...(input.amount !== undefined && { amount: input.amount }),
          // Stripe's enum is fixed (`duplicate` / `fraudulent` /
          // `requested_by_customer`); the operator's own words go in metadata
          // where they survive for whoever reads this later.
          ...(input.reason && { metadata: { rekey_reason: input.reason } }),
        },
        { idempotencyKey: input.idempotencyKey },
      );
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // `charge_already_refunded` is the one refusal an operator can read off
      // the screen and act on without opening Stripe.
      if (err.code === 'charge_already_refunded') {
        throw new RekeyError({
          statusCode: 409,
          code: 'BILLING_PAYMENT_ALREADY_REFUNDED',
          message: 'Stripe has already refunded this charge in full.',
          fix: 'Nothing to do, the buyer has their money. Resolve the case as refunded.',
        });
      }
      throw new RekeyError({
        statusCode: 502,
        code: 'BILLING_REFUND_REJECTED',
        message: `Stripe refused the refund: ${err.message ?? 'no reason given'}`,
        fix: 'Check the charge in the Stripe dashboard. A charge outside the window, or one whose funding source is gone, has to be settled with the buyer another way.',
      });
    }
    return {
      refundId: refund.id,
      amount: refund.amount,
      currency: refund.currency.toUpperCase(),
      // Stripe's `pending` is a real state for delayed-notification methods.
      // Anything that is not outright succeeded is reported as pending so the
      // caller waits for the webhook rather than telling an operator the money
      // has moved when it has not.
      status: refund.status === 'succeeded' ? 'succeeded' : 'pending',
    };
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
    if (!input.subscription.providerSubId) {
      // Local PENDING subscription that never made it to Stripe, nothing to cancel.
      return;
    }
    if (input.atPeriodEnd === false) {
      await this.stripe.subscriptions.cancel(input.subscription.providerSubId);
    } else {
      await this.stripe.subscriptions.update(input.subscription.providerSubId, {
        cancel_at_period_end: true,
      });
    }
  }
}
