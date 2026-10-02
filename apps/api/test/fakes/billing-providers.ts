/**
 * Fake BillingProviders, **test fixtures, never shipped**.
 *
 * These used to live in `src/modules/billing/providers/` as `*StubProvider`
 * classes that production code reached for whenever credentials were missing
 * or `NODE_ENV=test`. That made "we have no payment processor configured" a
 * silent success in every environment but production, which is the opposite of
 * what a billing system should do. The shipped factory now throws
 * `BILLING_CREDENTIALS_NOT_CONFIGURED`, and the fakes moved here, the only
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
import { RekeyError } from '../../src/lib/error.js';
import { ExternalBillingProvider } from '../../src/modules/billing/providers/external.js';
import type {
  BillingProvider,
  CancelSubscriptionInput,
  CheckoutSessionInput,
  CheckoutSessionResult,
  EmbeddedCheckoutInput,
  EmbeddedCheckoutResult,
  HostedFallbackInput,
  ProviderCheckoutSessionSnapshot,
  ProviderOrderSnapshot,
  ProviderPaymentSnapshot,
  ProviderPlanRef,
  ProviderSubscriptionSnapshot,
} from '../../src/modules/billing/providers/types.js';

function deterministicId(prefix: string, ...parts: string[]): string {
  const hash = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  return `${prefix}_${hash}`;
}

export class FakeStripeProvider implements BillingProvider {
  readonly name = 'stripe';
  /**
   * The last checkout input this fake was handed. "Did the discount actually
   * leave Rekey?" is only answerable by looking at what the provider received,
   * the response DTO reported a `discountAmount` for months while the
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

  lastEmbedded: EmbeddedCheckoutInput | null = null;
  /** Stripe's side of each Checkout Session this fake created, for the page's checks. Tests edit it. */
  readonly sessions = new Map<string, ProviderCheckoutSessionSnapshot>();
  /** Every hosted fallback asked for, with the embedded session it replaced. */
  readonly fallbacks: HostedFallbackInput[] = [];

  async createEmbeddedCheckout(input: EmbeddedCheckoutInput): Promise<EmbeddedCheckoutResult> {
    this.lastEmbedded = input;
    const sessionId = `cs_test_embed${randomUUID().replace(/-/g, '')}`;
    this.sessions.set(sessionId, {
      id: sessionId,
      status: 'open',
      paymentStatus: 'unpaid',
      clientReferenceId: `${input.application.id}:${input.endUser.id}`,
      metadata: { applicationId: input.application.id, endUserId: input.endUser.id, planId: input.plan.id },
      amountTotal: input.trial ? 0 : input.plan.amount - (input.discount?.amount ?? 0),
      currency: input.plan.currency.toUpperCase(),
      url: null,
    });
    return {
      sessionId,
      client: { provider: 'stripe', publishableKey: 'pk_test_ci_only', clientSecret: `${sessionId}_secret_ci`, sdk: 'elements' },
      fallbackUrl: null,
      providerPlanId: input.kind === 'recurring' ? 'price_ci' : null,
    };
  }

  async getCheckoutSession(id: string): Promise<ProviderCheckoutSessionSnapshot | null> {
    return this.sessions.get(id) ?? null;
  }

  async expireCheckoutSession(id: string): Promise<void> {
    const current = this.sessions.get(id);
    if (current) this.sessions.set(id, { ...current, status: 'expired' });
  }

  /** Mirrors the real one: a paid embedded session is refused, an open one is expired first. */
  async createHostedFallback(input: HostedFallbackInput): Promise<CheckoutSessionResult> {
    const embedded = this.sessions.get(input.embeddedSessionId);
    if (!embedded) throw new Error(`no such Checkout Session ${input.embeddedSessionId}`);
    if (embedded.status === 'complete') {
      throw new RekeyError({ statusCode: 409, code: 'CHECKOUT_SESSION_COMPLETE', message: 'paid', fix: 'none' });
    }
    this.sessions.set(embedded.id, { ...embedded, status: 'expired' });
    this.fallbacks.push(input);
    const sessionId = `cs_test_hosted${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 24)}`;
    const url = `https://checkout.stripe.com/c/pay/${sessionId}`;
    this.sessions.set(sessionId, { ...embedded, id: sessionId, status: 'open', url });
    return { sessionId, url };
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
    this.recordOrder(sessionId, input);
    const url = `${input.successUrl}${input.successUrl.includes('?') ? '&' : '?'}stub_provider=paypal&stub_order=${sessionId}`;
    return { url, sessionId };
  }
  private recordOrder(orderId: string, input: CheckoutSessionInput): void {
    this.orders.set(orderId, {
      id: orderId,
      status: 'APPROVED',
      customId: `${input.application.id}:${input.endUser.id}`,
      amount: input.plan.amount - (input.discount?.amount ?? 0),
      currency: input.plan.currency.toUpperCase(),
    });
  }
  lastEmbedded: EmbeddedCheckoutInput | null = null;
  /** PayPal's side of each subscription this fake created, for approval checks. Tests edit it. */
  readonly subscriptions = new Map<string, ProviderSubscriptionSnapshot>();
  async getSubscription(id: string): Promise<ProviderSubscriptionSnapshot | null> {
    return this.subscriptions.get(id) ?? null;
  }
  /** PayPal's side of each one-time order this fake created. Tests edit it. */
  readonly orders = new Map<string, ProviderOrderSnapshot>();
  async getOrder(id: string): Promise<ProviderOrderSnapshot | null> {
    return this.orders.get(id) ?? null;
  }
  async createEmbeddedCheckout(input: EmbeddedCheckoutInput): Promise<EmbeddedCheckoutResult> {
    this.lastEmbedded = input;
    if (input.kind === 'one_time') {
      const orderId = `ORDEREMBED${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
      this.recordOrder(orderId, input);
      this.orders.set(orderId, { ...this.orders.get(orderId)!, status: 'CREATED' });
      return {
        sessionId: orderId,
        client: { provider: 'paypal', clientId: 'client_ci_only', orderId, sdk: 'v5-order', currency: input.plan.currency.toUpperCase() },
        fallbackUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
        providerPlanId: null,
      };
    }
    if (input.discount) throw discountUnsupported(this.name, 'recurring');
    const sessionId = `I-EMBED${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    this.subscriptions.set(sessionId, {
      id: sessionId,
      status: 'APPROVAL_PENDING',
      planId: `P-stub-${input.plan.slug}`,
      customId: `${input.application.id}:${input.endUser.id}`,
    });
    return {
      sessionId,
      client: { provider: 'paypal', clientId: 'client_ci_only', subscriptionId: sessionId, sdk: 'v5-subscription' },
      fallbackUrl: `https://www.sandbox.paypal.com/checkoutnow?ba_token=BA-${sessionId}`,
      providerPlanId: `P-stub-${input.plan.slug}`,
    };
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
 * No `registerWebhook` on purpose, Razorpay has no auto-configuration API,
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
    this.subscriptions.set(sessionId, { id: sessionId, status: 'created', planId: `plan_stub_${input.plan.slug}`, customId: null });
    const url = `${input.successUrl}${input.successUrl.includes('?') ? '&' : '?'}stub_provider=razorpay&stub_session=${sessionId}`;
    return { url, sessionId };
  }
  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    this.lastCheckout = input;
    const sessionId = `plink_stub_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const url = `${input.successUrl}${input.successUrl.includes('?') ? '&' : '?'}stub_provider=razorpay&stub_plink=${sessionId}`;
    return { url, sessionId };
  }
  lastEmbedded: EmbeddedCheckoutInput | null = null;
  /** Razorpay's side of each payment, for approval checks. Tests write it. */
  readonly payments = new Map<string, ProviderPaymentSnapshot>();
  readonly captured: Array<{ id: string; amount: number; currency: string }> = [];
  /** Razorpay's side of each subscription this fake created. Tests edit it. */
  readonly subscriptions = new Map<string, ProviderSubscriptionSnapshot>();
  async getSubscription(id: string): Promise<ProviderSubscriptionSnapshot | null> {
    return this.subscriptions.get(id) ?? null;
  }
  async createEmbeddedCheckout(input: EmbeddedCheckoutInput): Promise<EmbeddedCheckoutResult> {
    this.lastEmbedded = input;
    const suffix = randomUUID().replace(/-/g, '').slice(0, 14);
    if (input.kind === 'recurring') {
      if (input.discount) throw discountUnsupported(this.name, 'recurring');
      const id = `sub_${suffix}`;
      this.subscriptions.set(id, { id, status: 'created', planId: `plan_stub_${input.plan.slug}`, customId: null });
      return {
        sessionId: id,
        client: { provider: 'razorpay', keyId: 'rzp_test_ci', sdk: 'razorpay-checkout', target: { kind: 'subscription', subscriptionId: id } },
        fallbackUrl: `https://rzp.io/i/${suffix}`,
        providerPlanId: `plan_stub_${input.plan.slug}`,
      };
    }
    const id = `order_${suffix}`;
    return {
      sessionId: id,
      client: { provider: 'razorpay', keyId: 'rzp_test_ci', sdk: 'razorpay-checkout', target: { kind: 'order', orderId: id } },
      fallbackUrl: '',
      providerPlanId: null,
    };
  }
  async getPayment(id: string): Promise<ProviderPaymentSnapshot | null> {
    return this.payments.get(id) ?? null;
  }
  async capturePayment(id: string, amount: number, currency: string): Promise<void> {
    this.captured.push({ id, amount, currency });
    const current = this.payments.get(id);
    if (current) this.payments.set(id, { ...current, status: 'captured' });
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
  // Not faked: the real one dials nobody, and what a test wants from it is
  // exactly its refusals.
  if (name === 'external') return new ExternalBillingProvider();
  return fakeStripe;
}
