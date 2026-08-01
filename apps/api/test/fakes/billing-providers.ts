/**
 * Fake BillingProviders — **test fixtures, never shipped**.
 *
 * These used to live in `src/modules/billing/providers/` as `*StubProvider`
 * classes that production code reached for whenever credentials were missing
 * or `NODE_ENV=test`. That made "we have no payment processor configured" a
 * silent success in every environment but production, which is the opposite of
 * what a billing system should do. The shipped factory now throws
 * `BILLING_CREDENTIALS_NOT_CONFIGURED`, and the fakes moved here — the only
 * place that is allowed to pretend a charge happened.
 *
 * They are installed for every test file by `test/setup.ts`, which mocks
 * `getProviderForApplication`. A test that wants the real refusal can
 * `vi.unmock` / re-mock it locally.
 *
 * The generated ids are **deterministic** (same input → same id) because a
 * number of tests assert on their exact shape.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Plan } from '@prisma/client';
import { discountUnsupported } from '../../src/modules/billing/providers/discount.js';
import type {
  BillingProvider,
  CancelSubscriptionInput,
  CheckoutSessionInput,
  CheckoutSessionResult,
  ProviderPlanRef,
} from '../../src/modules/billing/providers/types.js';

function deterministicId(prefix: string, ...parts: string[]): string {
  const hash = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  return `${prefix}_${hash}`;
}

export class FakeStripeProvider implements BillingProvider {
  readonly name = 'stripe';
  /**
   * The last checkout input this fake was handed. "Did the discount actually
   * leave Rekey?" is only answerable by looking at what the provider received
   * — the response DTO reported a `discountAmount` for months while the
   * provider was being told nothing at all.
   */
  lastCheckout: CheckoutSessionInput | null = null;

  constructor(private readonly creds: { apiKey: string; webhookSecret: string } | null = null) {}

  getWebhookSecret(): string | null {
    return this.creds?.webhookSecret ?? null;
  }

  async ensurePlanRegistered(plan: Plan): Promise<ProviderPlanRef> {
    return {
      providerPlanId: deterministicId('price', plan.id, plan.amount.toString(), plan.interval),
    };
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    this.lastCheckout = input;
    // The applicationId is baked into the session id so webhook fixtures can
    // round-trip it through metadata, the way Stripe's own metadata does.
    const sessionId = deterministicId(
      'cs',
      input.application.id,
      input.endUser.id,
      input.plan.id,
      Date.now().toString(),
    );
    return { sessionId, url: `https://checkout.stripe.example/${sessionId}` };
  }

  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    this.lastCheckout = input;
    const sessionId = deterministicId(
      'cs_ot',
      input.application.id,
      input.endUser.id,
      input.plan.id,
      Date.now().toString(),
    );
    return { sessionId, url: `https://checkout.stripe.example/onetime/${sessionId}` };
  }

  async registerWebhook(publicUrl: string): Promise<{ secret?: string; webhookId?: string }> {
    return {
      webhookId: deterministicId('we', publicUrl),
      secret: `whsec_${createHash('sha256').update(publicUrl).digest('hex').slice(0, 32)}`,
    };
  }

  async cancelSubscription(_input: CancelSubscriptionInput): Promise<void> {
    return;
  }
}

export class FakePaypalProvider implements BillingProvider {
  readonly name = 'paypal';
  lastCheckout: CheckoutSessionInput | null = null;
  async ensurePlanRegistered(plan: Plan): Promise<ProviderPlanRef> {
    return { providerPlanId: `P-stub-${plan.slug}` };
  }
  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    // Mirrors the real class on purpose: Subscriptions v1 cannot take an
    // ad-hoc discount. A fake that accepted one would let the capability gate
    // in checkout-discount.ts be removed without a single test noticing, and
    // the whole point of that gate is that dropping a discount silently is how
    // buyers get overcharged.
    if (input.discount) throw discountUnsupported(this.name, 'recurring');
    this.lastCheckout = input;
    const sessionId = `BAID-stub-${randomUUID()}`;
    const url = `${input.successUrl}${input.successUrl.includes('?') ? '&' : '?'}stub_provider=paypal&stub_session=${sessionId}`;
    return { url, sessionId };
  }
  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    this.lastCheckout = input;
    const sessionId = `ORDER-stub-${randomUUID()}`;
    const url = `${input.successUrl}${input.successUrl.includes('?') ? '&' : '?'}stub_provider=paypal&stub_order=${sessionId}`;
    return { url, sessionId };
  }
  async captureOneTime(_orderId: string): Promise<{ captured: boolean }> {
    return { captured: true };
  }
  async registerWebhook(publicUrl: string): Promise<{ webhookId?: string }> {
    return {
      webhookId: `WH-stub-${createHash('sha256').update(publicUrl).digest('hex').slice(0, 20)}`,
    };
  }
  async cancelSubscription(_input: CancelSubscriptionInput): Promise<void> {
    /* no-op */
  }
}

/**
 * No `registerWebhook` on purpose — Razorpay has no auto-configuration API,
 * and `billing/webhook-registration.ts` is expected to answer
 * `BILLING_WEBHOOK_AUTOCONFIG_UNSUPPORTED` for it.
 */
export class FakeRazorpayProvider implements BillingProvider {
  readonly name = 'razorpay';
  lastCheckout: CheckoutSessionInput | null = null;
  async ensurePlanRegistered(plan: Plan): Promise<ProviderPlanRef> {
    return { providerPlanId: `plan_stub_${plan.slug}` };
  }
  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    // Same reason as the PayPal fake: Razorpay Subscriptions has no ad-hoc
    // discount surface, so accepting one here would hide a real regression.
    if (input.discount) throw discountUnsupported(this.name, 'recurring');
    this.lastCheckout = input;
    const sessionId = `sub_stub_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const url = `${input.successUrl}${input.successUrl.includes('?') ? '&' : '?'}stub_provider=razorpay&stub_session=${sessionId}`;
    return { url, sessionId };
  }
  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    this.lastCheckout = input;
    const sessionId = `plink_stub_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const url = `${input.successUrl}${input.successUrl.includes('?') ? '&' : '?'}stub_provider=razorpay&stub_plink=${sessionId}`;
    return { url, sessionId };
  }
  async cancelSubscription(_input: CancelSubscriptionInput): Promise<void> {
    /* no-op */
  }
}

/** Singletons, so `vi.spyOn(fakeStripe, 'cancelSubscription')` sees every call. */
export const fakeStripe = new FakeStripeProvider();
export const fakePaypal = new FakePaypalProvider();
export const fakeRazorpay = new FakeRazorpayProvider();

export function fakeProviderFor(name: string): BillingProvider {
  if (name === 'paypal') return fakePaypal;
  if (name === 'razorpay') return fakeRazorpay;
  return fakeStripe;
}
