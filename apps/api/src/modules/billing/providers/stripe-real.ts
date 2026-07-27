/**
 * Real Stripe BillingProvider — uses the official `stripe` SDK with the
 * Application's BYO API key.
 *
 * Picked by `getProviderForApplication` when:
 *   - `Application.billingConfig.provider === 'stripe'`
 *   - The Application has BYO credentials configured (apiKey + webhookSecret).
 *
 * Without BYO creds we fall back to `StripeStubProvider` so dev / CI work
 * without a real account. The interface (`types.ts`) is identical, so
 * every caller is provider-implementation-agnostic.
 *
 * Tests don't call this against api.stripe.com — they pin behaviour
 * against the stub. To exercise this class for real, set up a Stripe
 * test account, configure BYO via the panel, and run end-to-end manually.
 */

import Stripe from 'stripe';
import type {
  BillingProvider,
  CancelSubscriptionInput,
  CheckoutSessionInput,
  CheckoutSessionResult,
  ProviderPlanRef,
} from './types.js';
import type { Plan } from '@prisma/client';

interface RealStripeCreds {
  apiKey: string;
  webhookSecret: string;
}

export class RealStripeProvider implements BillingProvider {
  readonly name = 'stripe';
  private readonly stripe: Stripe;

  constructor(private readonly creds: RealStripeCreds) {
    this.stripe = new Stripe(creds.apiKey, {
      apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
    });
  }

  /** Per-app webhook secret. Used by the per-application webhook route. */
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
        relipayPlanId: plan.id,
        relipayApplicationId: plan.applicationId,
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
        relipayPlanId: plan.id,
      },
    });

    return { providerPlanId: price.id };
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const priceId = (input.plan.metadata as { stripe?: { priceId?: string } } | null)?.stripe?.priceId;
    if (!priceId) {
      // Should never happen — plansService.create calls ensurePlanRegistered
      // first. Belt-and-braces: bail loudly.
      throw new Error(
        `Plan "${input.plan.slug}" has no Stripe priceId in metadata. Re-create the plan to register it.`,
      );
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: input.endUser.email,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
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

    if (!session.url) {
      throw new Error('Stripe returned a checkout session without a `url`.');
    }
    return { sessionId: session.id, url: session.url };
  }

  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    // One-off charge — `mode: 'payment'`, inline price_data (no recurring
    // Price). `checkout.session.completed` fires on success and our existing
    // webhook handler grants credits / issues the license by plan.kind.
    const session = await this.stripe.checkout.sessions.create({
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
    if (!session.url) {
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
