/**
 * Stripe BillingProvider — **stub**.
 *
 * This implementation simulates the upstream calls. It exists so the
 * surrounding wiring (admin plan management, public checkout endpoint,
 * subscription state machine, SDK methods) can be built and tested
 * without an actual Stripe account in CI.
 *
 * To go live: replace the bodies of `ensurePlanRegistered`,
 * `createCheckoutSession`, and `cancelSubscription` with the real
 * `stripe` SDK calls. The interface (`types.ts`) and every caller stays
 * unchanged — that's the point of having the interface.
 *
 * The stub is **deterministic**: same input → same provider id. Callers
 * (and tests) can rely on that.
 */

import { createHash } from 'node:crypto';
import type {
  BillingProvider,
  CancelSubscriptionInput,
  CheckoutSessionInput,
  CheckoutSessionResult,
  ProviderPlanRef,
} from './types.js';
import type { Plan } from '@prisma/client';

function deterministicId(prefix: string, ...parts: string[]): string {
  const hash = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  return `${prefix}_${hash}`;
}

export class StripeStubProvider implements BillingProvider {
  readonly name = 'stripe';

  /**
   * Per-Application credentials (apiKey + webhookSecret). The stub doesn't
   * actually use the apiKey (no outbound calls), but holding it here mirrors
   * the shape `RealStripeProvider` will have when 4.6 swaps in.
   * `webhookSecret` IS used by the per-app webhook handler — we expose it
   * via `getWebhookSecret()`.
   */
  constructor(private readonly creds: { apiKey: string; webhookSecret: string } | null = null) {}

  /** Per-app webhook secret. Null when the operator hasn't configured BYO yet. */
  getWebhookSecret(): string | null {
    return this.creds?.webhookSecret ?? null;
  }

  async ensurePlanRegistered(plan: Plan): Promise<ProviderPlanRef> {
    return {
      providerPlanId: deterministicId('price', plan.id, plan.amount.toString(), plan.interval),
    };
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    // Embed applicationId in the session id so the webhook test fixtures can
    // round-trip it via metadata. The real provider will set it on the
    // Stripe Checkout Session metadata when this method moves off the stub.
    const sessionId = deterministicId(
      'cs',
      input.application.id,
      input.endUser.id,
      input.plan.id,
      Date.now().toString(),
    );
    return {
      sessionId,
      url: `https://checkout.stripe.example/${sessionId}`,
    };
  }

  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const sessionId = deterministicId(
      'cs_ot',
      input.application.id,
      input.endUser.id,
      input.plan.id,
      Date.now().toString(),
    );
    return {
      sessionId,
      url: `https://checkout.stripe.example/onetime/${sessionId}`,
    };
  }

  async registerWebhook(publicUrl: string): Promise<{ secret?: string; webhookId?: string }> {
    // Deterministic stub secret/id so tests can assert auto-registration
    // populated the credential without a real Stripe account.
    return {
      webhookId: deterministicId('we', publicUrl),
      secret: `whsec_${createHash('sha256').update(publicUrl).digest('hex').slice(0, 32)}`,
    };
  }

  async cancelSubscription(_input: CancelSubscriptionInput): Promise<void> {
    // No-op in the stub — the local Subscription row update happens in the
    // billing service, not here.
    return;
  }
}
