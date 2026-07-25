/**
 * PayPal billing provider — real implementation backed by `@paypal/paypal-server-sdk`.
 *
 * Uses Subscriptions v1 (the SDK ships REST helpers; we drive plans via
 * direct fetch to the `/v1/billing/plans` and `/v1/billing/subscriptions`
 * endpoints because the SDK's billing surface in v2 is a thin REST wrapper
 * with awkward types).
 *
 * Mode (`test` → sandbox, `live` → production) selects the API base URL.
 *
 * Webhook verification is delegated to the operator's hosted webhook ID (we
 * call `/v1/notifications/verify-webhook-signature`) — see
 * modules/paypal/index.ts (the ProviderModule).
 *
 * Stub remains importable for tests (NODE_ENV=test, RELIPAY_BILLING_FORCE_STUB).
 */

import { randomUUID, createHash } from 'node:crypto';
import type { Plan } from '@prisma/client';
import type {
  BillingProvider,
  CancelSubscriptionInput,
  CheckoutSessionInput,
  CheckoutSessionResult,
  ProviderPlanRef,
} from './types.js';
import type { PaypalCredentials, BillingMode } from '../credentials.service.js';

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const LIVE_BASE = 'https://api-m.paypal.com';

interface AccessToken {
  access_token: string;
  expires_at: number; // ms epoch
}

export class RealPaypalProvider implements BillingProvider {
  readonly name = 'paypal';
  private readonly base: string;
  private readonly creds: PaypalCredentials;
  private accessTokenCache: AccessToken | null = null;

  constructor(creds: PaypalCredentials, mode: BillingMode) {
    this.creds = creds;
    this.base = mode === 'live' ? LIVE_BASE : SANDBOX_BASE;
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessTokenCache && this.accessTokenCache.expires_at - 30_000 > now) {
      return this.accessTokenCache.access_token;
    }
    const auth = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64');
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      throw new Error(`PayPal token fetch failed: HTTP ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessTokenCache = {
      access_token: json.access_token,
      expires_at: now + json.expires_in * 1000,
    };
    return json.access_token;
  }

  async ensurePlanRegistered(plan: Plan): Promise<ProviderPlanRef> {
    // PayPal subscriptions need a Product first, then a billing Plan referencing it.
    // We create-or-reuse a single product per ReliPay Application slug to keep things tidy.
    const token = await this.accessToken();
    const productId = `RELIPAY-PROD-${plan.applicationId.slice(0, 18)}`;
    // Try create the product (idempotent via PayPal-Request-Id).
    await fetch(`${this.base}/v1/catalogs/products`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': productId,
      },
      body: JSON.stringify({
        id: productId,
        name: `ReliPay App ${plan.applicationId}`,
        type: 'SERVICE',
        category: 'SOFTWARE',
      }),
    });
    // Ignore non-2xx — most commonly 422 "ALREADY_EXISTS" which we want.

    const requestId = `RELIPAY-PLAN-${plan.id}`;
    const interval = plan.interval === 'YEAR' ? 'YEAR' : 'MONTH';
    const valueMajor = (plan.amount / 100).toFixed(2);
    const planRes = await fetch(`${this.base}/v1/billing/plans`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': requestId,
      },
      body: JSON.stringify({
        product_id: productId,
        name: plan.name,
        billing_cycles: [
          {
            frequency: { interval_unit: interval, interval_count: 1 },
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: { value: valueMajor, currency_code: plan.currency },
            },
          },
        ],
        payment_preferences: { auto_bill_outstanding: true },
      }),
    });
    if (!planRes.ok && planRes.status !== 422 /* duplicate */) {
      throw new Error(`PayPal plan create failed: HTTP ${planRes.status} ${await planRes.text()}`);
    }
    const planJson = (await planRes.json()) as { id?: string };
    return { providerPlanId: planJson.id ?? requestId };
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const token = await this.accessToken();
    // Lookup or create the PayPal plan id.
    const meta = (input.plan.metadata as Record<string, unknown> | null) ?? {};
    const paypalMeta = (meta.paypal as { planId?: string } | undefined) ?? {};
    let paypalPlanId = paypalMeta.planId;
    if (!paypalPlanId) {
      paypalPlanId = (await this.ensurePlanRegistered(input.plan)).providerPlanId;
    }

    const requestId = `RELIPAY-SUB-${randomUUID()}`;
    const subRes = await fetch(`${this.base}/v1/billing/subscriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': requestId,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        plan_id: paypalPlanId,
        // Encode `${applicationId}:${endUserId}` so the webhook can
        // cross-check the Application even when it can only see the
        // subscription resource. Primary routing is still the per-app
        // webhook URL slug; this is defense-in-depth + global-endpoint
        // support.
        custom_id: `${input.application.id}:${input.endUser.id}`,
        application_context: {
          return_url: input.successUrl,
          cancel_url: input.cancelUrl,
          user_action: 'SUBSCRIBE_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
        subscriber: input.endUser.email
          ? { email_address: input.endUser.email }
          : undefined,
      }),
    });
    if (!subRes.ok) {
      throw new Error(`PayPal subscription create failed: HTTP ${subRes.status} ${await subRes.text()}`);
    }
    const sub = (await subRes.json()) as {
      id: string;
      links: Array<{ rel: string; href: string }>;
    };
    const approve = sub.links.find((l) => l.rel === 'approve');
    if (!approve) {
      throw new Error('PayPal subscription response missing approve link');
    }
    return { url: approve.href, sessionId: sub.id };
  }

  /**
   * One-time purchase via Orders v2 (intent CAPTURE). Returns the approve
   * link; the buyer approves, then the order is captured (see `captureOneTime`,
   * driven by the `CHECKOUT.ORDER.APPROVED` webhook). `custom_id` carries
   * `${appId}:${euId}`; the local row is matched by order id.
   */
  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const token = await this.accessToken();
    const requestId = `RELIPAY-ORDER-${randomUUID()}`;
    const valueMajor = (input.plan.amount / 100).toFixed(2);
    const res = await fetch(`${this.base}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': requestId,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: `${input.application.id}:${input.endUser.id}`,
            description: input.plan.name.slice(0, 127),
            amount: { currency_code: input.plan.currency, value: valueMajor },
          },
        ],
        application_context: {
          return_url: input.successUrl,
          cancel_url: input.cancelUrl,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`PayPal order create failed: HTTP ${res.status} ${await res.text()}`);
    }
    const order = (await res.json()) as { id: string; links: Array<{ rel: string; href: string }> };
    const approve = order.links.find((l) => l.rel === 'approve' || l.rel === 'payer-action');
    if (!approve) throw new Error('PayPal order response missing approve link');
    return { url: approve.href, sessionId: order.id };
  }

  /**
   * Capture an approved one-time order. Idempotent: a re-capture of an
   * already-captured order (HTTP 422 ORDER_ALREADY_CAPTURED) counts as success
   * so webhook replays don't error.
   */
  async captureOneTime(orderId: string): Promise<{ captured: boolean }> {
    const token = await this.accessToken();
    const res = await fetch(`${this.base}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 422 && text.includes('ORDER_ALREADY_CAPTURED')) return { captured: true };
      throw new Error(`PayPal order capture failed: HTTP ${res.status} ${text}`);
    }
    const data = (await res.json()) as { status?: string };
    return { captured: data.status === 'COMPLETED' };
  }

  /**
   * Create (or reuse) a PayPal webhook at `publicUrl` subscribed to the events
   * our handler consumes. Returns the webhook id (needed for signature
   * verification). Reuses the existing webhook on WEBHOOK_URL_ALREADY_EXISTS.
   */
  async registerWebhook(publicUrl: string): Promise<{ webhookId?: string }> {
    const token = await this.accessToken();
    const eventTypes = [
      'BILLING.SUBSCRIPTION.ACTIVATED',
      'BILLING.SUBSCRIPTION.CANCELLED',
      'BILLING.SUBSCRIPTION.EXPIRED',
      'BILLING.SUBSCRIPTION.SUSPENDED',
      'CHECKOUT.ORDER.APPROVED',
      'PAYMENT.SALE.COMPLETED',
      'PAYMENT.SALE.DENIED',
      'PAYMENT.SALE.REVERSED',
      'PAYMENT.CAPTURE.COMPLETED',
    ].map((name) => ({ name }));

    const res = await fetch(`${this.base}/v1/notifications/webhooks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: publicUrl, event_types: eventTypes }),
    });
    if (res.ok) {
      const json = (await res.json()) as { id: string };
      return { webhookId: json.id };
    }
    const text = await res.text();
    // Already registered for this URL → look it up and return its id.
    if (text.includes('WEBHOOK_URL_ALREADY_EXISTS')) {
      const listRes = await fetch(`${this.base}/v1/notifications/webhooks`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const list = (await listRes.json()) as { webhooks?: Array<{ id: string; url: string }> };
      const match = list.webhooks?.find((w) => w.url === publicUrl);
      if (match) return { webhookId: match.id };
    }
    throw new Error(`PayPal webhook register failed: HTTP ${res.status} ${text}`);
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
    const providerSubId = input.subscription.providerSubId;
    if (!providerSubId) return;
    const token = await this.accessToken();
    await fetch(`${this.base}/v1/billing/subscriptions/${providerSubId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Cancelled via ReliPay' }),
    });
  }
}

/**
 * Verify an inbound PayPal webhook signature.
 *
 * PayPal verification is ONLINE (unlike Stripe's offline HMAC): we POST the
 * transmission headers + the parsed event body + our webhook id to
 * `/v1/notifications/verify-webhook-signature` and trust the
 * `verification_status`. Requires a fresh access token minted from the
 * Application's PayPal client credentials.
 *
 * Returns true only on `verification_status === 'SUCCESS'`. Any network
 * error / non-2xx / non-SUCCESS → false (fail-closed; the route rejects).
 */
export async function verifyPaypalWebhook(args: {
  creds: PaypalCredentials;
  mode: BillingMode;
  headers: Record<string, string | string[] | undefined>;
  /** The parsed webhook event object (PayPal re-canonicalises server-side). */
  event: unknown;
}): Promise<boolean> {
  const base = args.mode === 'live' ? LIVE_BASE : SANDBOX_BASE;

  const header = (k: string): string | undefined => {
    const v = args.headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : typeof v === 'string' ? v : undefined;
  };
  const transmissionId = header('paypal-transmission-id');
  const transmissionTime = header('paypal-transmission-time');
  const certUrl = header('paypal-cert-url');
  const authAlgo = header('paypal-auth-algo');
  const transmissionSig = header('paypal-transmission-sig');
  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    return false;
  }

  // Mint an access token (basic-auth client_credentials).
  const auth = Buffer.from(`${args.creds.clientId}:${args.creds.clientSecret}`).toString('base64');
  let token: string;
  try {
    const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!tokenRes.ok) return false;
    token = ((await tokenRes.json()) as { access_token: string }).access_token;
  } catch {
    return false;
  }

  try {
    const verifyRes = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transmission_id: transmissionId,
        transmission_time: transmissionTime,
        cert_url: certUrl,
        auth_algo: authAlgo,
        transmission_sig: transmissionSig,
        webhook_id: args.creds.webhookId,
        webhook_event: args.event,
      }),
    });
    if (!verifyRes.ok) return false;
    const json = (await verifyRes.json()) as { verification_status?: string };
    return json.verification_status === 'SUCCESS';
  } catch {
    return false;
  }
}

/** Fallback used in tests / when creds are missing. Deterministic stub URLs. */
export class PaypalStubProvider implements BillingProvider {
  readonly name = 'paypal';
  async ensurePlanRegistered(plan: Plan): Promise<ProviderPlanRef> {
    return { providerPlanId: `P-stub-${plan.slug}` };
  }
  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const sessionId = `BAID-stub-${randomUUID()}`;
    const url = `${input.successUrl}${input.successUrl.includes('?') ? '&' : '?'}stub_provider=paypal&stub_session=${sessionId}`;
    return { url, sessionId };
  }
  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const sessionId = `ORDER-stub-${randomUUID()}`;
    const url = `${input.successUrl}${input.successUrl.includes('?') ? '&' : '?'}stub_provider=paypal&stub_order=${sessionId}`;
    return { url, sessionId };
  }
  async captureOneTime(_orderId: string): Promise<{ captured: boolean }> {
    return { captured: true };
  }
  async registerWebhook(publicUrl: string): Promise<{ webhookId?: string }> {
    return { webhookId: `WH-stub-${createHash('sha256').update(publicUrl).digest('hex').slice(0, 20)}` };
  }
  async cancelSubscription(_input: CancelSubscriptionInput): Promise<void> {
    /* no-op */
  }
}
