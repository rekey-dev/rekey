/**
 * Real Stripe BillingProvider — uses the official `stripe` SDK with the
 * Application's BYO API key.
 *
 * Picked by `getProviderForApplication` when the Application has BYO Stripe
 * credentials (apiKey + webhookSecret). Without them the factory throws
 * `BILLING_CREDENTIALS_NOT_CONFIGURED` — there is no fallback.
 *
 * Tests don't call this against api.stripe.com; they substitute a fake from
 * `test/fakes/billing-providers.ts`. To exercise this class for real, set up
 * a Stripe test account, configure BYO via the panel, and run end-to-end.
 */

import Stripe from 'stripe';
import { RekeyError } from '../../../lib/error.js';
import { planNotRegisteredError } from '../../plans/plan-registration.js';
import type {
  BillingProvider,
  CancelSubscriptionInput,
  CheckoutDiscount,
  CheckoutSessionInput,
  CheckoutSessionResult,
  ProviderPlanRef,
} from './types.js';
import type { Plan } from '@prisma/client';

interface RealStripeCreds {
  apiKey: string;
  webhookSecret: string;
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

/** Hard ceiling on any Stripe API call. See the constructor for why. */
const STRIPE_TIMEOUT_MS = 10_000;

export class RealStripeProvider implements BillingProvider {
  readonly name = 'stripe';
  private readonly stripe: Stripe;

  constructor(private readonly creds: RealStripeCreds) {
    this.stripe = new Stripe(creds.apiKey, {
      apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
      // The SDK default is 80 seconds. Every call from this class is made
      // while an operator or an end-user is waiting on an HTTP response, and
      // 80s of holding a handler open is indistinguishable from an outage
      // from the caller's side. 10s matches the budget the PayPal/Razorpay
      // providers and the OAuth exchanges use.
      timeout: STRIPE_TIMEOUT_MS,
      // One retry, which the SDK only applies to requests it knows are safe to
      // repeat (it sends an idempotency key on writes). Default is 0.
      maxNetworkRetries: 1,
    });
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
   * `discounts` array a Checkout Session takes. Both modes accept it —
   * `payment` applies it to the session total, `subscription` to the invoice.
   *
   * `amount_off`, never `percent_off`. Rekey has already resolved a PERCENT
   * coupon against the plan and written that integer to
   * `Subscription.metadata.discountAmount` (and it is what the operator sees
   * in the coupon stats). Handing Stripe the percentage instead lets it
   * recompute against its own base — proration, tax — and what the buyer is
   * charged silently stops matching what we recorded and redeemed.
   *
   * `duration: 'once'` for the same reason exactly one redemption is
   * recorded: the code buys the first invoice, not every invoice. `'forever'`
   * would hand out a permanent price cut our books never knew about.
   *
   * Minted per checkout and capped — `max_redemptions: 1` plus a short
   * `redeem_by` — so an abandoned checkout cannot leave a live, reusable
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
    } catch (e) {
      // Stripe refusing the coupon is a coupon problem, and it is the buyer
      // who is standing in front of it. Left raw it surfaced as an opaque 500
      // — indistinguishable from Rekey being down — so the one thing the
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
   * the coupon id — so a session that fails to create leaves a live, usable
   * discount object behind that nothing will ever reference. Best-effort: the
   * checkout has already failed and the caller's error is the one worth
   * reporting, so a failed cleanup must not replace it.
   *
   * Abandonment by the BUYER (session created, never paid) is not cleaned up
   * here and deliberately so — the session may still be completed. Those
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
    const priceId = (input.plan.metadata as { stripe?: { priceId?: string } } | null)?.stripe?.priceId;
    if (!priceId) {
      // Reachable, and it was reached: a plan whose eager registration was
      // refused used to be committed active anyway, so it sat on the pricing
      // page until a buyer clicked it and arrived here. `plansService` now
      // keeps such a plan off the catalogue, and a legacy row from before that
      // fix still lands here — with a named 409 and the operator's repair
      // instead of the bare `Error` that became "An unexpected error occurred",
      // 500, and a cause visible only in a server log.
      throw planNotRegisteredError({
        planSlug: input.plan.slug,
        provider: 'Stripe',
        applicationId: input.application.id,
      });
    }

    const minted = input.discount ? await this.createDiscount(input.discount) : undefined;

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: input.endUser.email,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        ...(minted && { discounts: minted.discounts }),
        // Embed applicationId so our webhook handler can route the event
        // back to the right local Subscription. metadata propagates to the
        // resulting subscription/invoice events automatically.
        metadata: {
          applicationId: input.application.id,
          endUserId: input.endUser.id,
          planId: input.plan.id,
        },
        subscription_data: {
          metadata: {
            applicationId: input.application.id,
            endUserId: input.endUser.id,
            planId: input.plan.id,
          },
        },
      });
    } catch (e) {
      await this.discardDiscount(minted?.couponId);
      throw e;
    }

    if (!session.url) {
      await this.discardDiscount(minted?.couponId);
      throw new Error('Stripe returned a checkout session without a `url`.');
    }
    return { sessionId: session.id, url: session.url };
  }

  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    // One-off charge — `mode: 'payment'`, inline price_data (no recurring
    // Price). `checkout.session.completed` fires on success and our existing
    // webhook handler grants credits / issues the license by plan.kind.
    //
    // The discount rides as a Coupon rather than being subtracted from
    // `unit_amount`: the line item stays the plan's real price, so the buyer
    // sees a subtotal and a discount line instead of a mystery number, and
    // the operator's Stripe records carry the coupon that explains it.
    const minted = input.discount ? await this.createDiscount(input.discount) : undefined;

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.plan.currency.toLowerCase(),
              unit_amount: input.plan.amount,
              product_data: { name: input.plan.name },
            },
          },
        ],
        customer_email: input.endUser.email,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        ...(minted && { discounts: minted.discounts }),
        metadata: {
          applicationId: input.application.id,
          endUserId: input.endUser.id,
          planId: input.plan.id,
        },
        payment_intent_data: {
          metadata: {
            applicationId: input.application.id,
            endUserId: input.endUser.id,
            planId: input.plan.id,
          },
        },
      });
    } catch (e) {
      await this.discardDiscount(minted?.couponId);
      throw e;
    }
    if (!session.url) {
      await this.discardDiscount(minted?.couponId);
      throw new Error('Stripe returned a one-time checkout session without a `url`.');
    }
    return { sessionId: session.id, url: session.url };
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
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed',
    ];
    const existing = await this.stripe.webhookEndpoints.list({ limit: 100 });
    const match = existing.data.find((e) => e.url === publicUrl);
    if (match) {
      await this.stripe.webhookEndpoints.del(match.id);
    }
    const created = await this.stripe.webhookEndpoints.create({
      url: publicUrl,
      enabled_events: enabledEvents,
      description: 'Rekey (auto-configured)',
    });
    return { webhookId: created.id, ...(created.secret && { secret: created.secret }) };
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
    if (!input.subscription.providerSubId) {
      // Local PENDING subscription that never made it to Stripe — nothing to cancel.
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
