/**
 * PayPal billing provider — real implementation, driven by plain `fetch`.
 *
 * Uses Subscriptions v1 against `/v1/billing/plans` and
 * `/v1/billing/subscriptions` directly. `@paypal/paypal-server-sdk` is still a
 * declared dependency but is deliberately NOT imported here: its billing surface
 * is a thin REST wrapper with awkward types, so it bought nothing over fetch.
 *
 * Mode (`test` → sandbox, `live` → production) selects the API base URL.
 *
 * Webhook verification is delegated to the operator's hosted webhook ID (we
 * call `/v1/notifications/verify-webhook-signature`) — see
 * modules/paypal/index.ts (the ProviderModule).
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
import { discountUnsupported } from './discount.js';
import type { PaypalCredentials, BillingMode } from '../credentials.service.js';

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const LIVE_BASE = 'https://api-m.paypal.com';

/**
 * Hard ceiling on any outbound PayPal call.
 *
 * Node's undici has NO default request timeout, so a bare `fetch()` to a
 * wedged host hangs until the OS gives up on the socket — minutes, or never.
 * Every call in this file used to be a bare `fetch()`.
 *
 * 10s matches the outbound budget the OAuth providers and the webhook
 * dispatcher already use. These are operator-initiated management calls
 * (register a plan, create a checkout, cancel a subscription) where the caller
 * is a human waiting on an HTTP response.
 */
const PAYPAL_TIMEOUT_MS = 10_000;

/**
 * Tighter ceiling for the calls on the INBOUND WEBHOOK request path
 * (`verifyPaypalWebhook`: a token mint plus the verify POST, so the worst case
 * is 2× this).
 *
 * That path is the sharp one. It runs synchronously inside the Fastify handler
 * for every webhook PayPal sends; with no timeout at all, a wedged
 * api-m.paypal.com held a handler open indefinitely, PayPal retried and opened
 * another, and the process ran out of connections while `/health/live` — which
 * touches neither PayPal nor the handler pool — stayed green. Failing a
 * webhook fast costs one provider retry; holding it costs the API.
 */
const PAYPAL_WEBHOOK_TIMEOUT_MS = 4_000;

/**
 * `fetch` with a deadline. The signal stays armed after the response
 * resolves, so it covers the body read too — a server that returns headers
 * promptly and then trickles the body still hits the deadline.
 */
function paypalFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = PAYPAL_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Why the online verification is still on the request path.
 *
 * PayPal's signature check IS the authentication for the webhook route (there
 * is no bearer token; see pipeline.ts). Deferring it means either acting on an
 * unverified payload, or persisting one to a quarantine and building a second
 * pipeline to drain it — a new trust boundary and a new failure mode to buy
 * latency we do not otherwise have a problem with. The timeout above bounds
 * the damage, and an unreachable PayPal now answers 503 rather than 401 (see
 * `PaypalVerifyOutcome`) so the provider retries instead of being told its
 * signature was bad.
 */

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
    const res = await paypalFetch(`${this.base}/v1/oauth2/token`, {
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
    // We create-or-reuse a single product per Rekey Application slug to keep things tidy.
    const token = await this.accessToken();
    const productId = `REKEY-PROD-${plan.applicationId.slice(0, 18)}`;
    // Try create the product (idempotent via PayPal-Request-Id).
    await paypalFetch(`${this.base}/v1/catalogs/products`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': productId,
      },
      body: JSON.stringify({
        id: productId,
        name: `Rekey App ${plan.applicationId}`,
        type: 'SERVICE',
        category: 'SOFTWARE',
      }),
    });
    // Ignore non-2xx — most commonly 422 "ALREADY_EXISTS" which we want.

    const requestId = `REKEY-PLAN-${plan.id}`;
    const interval = plan.interval === 'YEAR' ? 'YEAR' : 'MONTH';
    const valueMajor = (plan.amount / 100).toFixed(2);
    const planRes = await paypalFetch(`${this.base}/v1/billing/plans`, {
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
    if (input.discount) {
      // Subscriptions v1 has no per-subscription coupon. The only price
      // control at create time is the inline `plan` override, which can just
      // restate the pricing_scheme of a cycle the plan already declares — and
      // ours declare a single REGULAR cycle with `total_cycles: 0`, so
      // discounting "the first period" would discount every period forever
      // against one recorded redemption. Refuse instead of billing a
      // permanently wrong price; see the module descriptor for the full note.
      //
      // `checkout-discount.ts` normally refuses this before a provider is even
      // built (`capabilities.discounts.recurring` is false). This is the
      // backstop for any caller that reaches the class directly.
      throw discountUnsupported(this.name, 'recurring');
    }
    const token = await this.accessToken();
    // Lookup or create the PayPal plan id.
    const meta = (input.plan.metadata as Record<string, unknown> | null) ?? {};
    const paypalMeta = (meta.paypal as { planId?: string } | undefined) ?? {};
    let paypalPlanId = paypalMeta.planId;
    if (!paypalPlanId) {
      paypalPlanId = (await this.ensurePlanRegistered(input.plan)).providerPlanId;
    }

    const requestId = `REKEY-SUB-${randomUUID()}`;
    const subRes = await paypalFetch(`${this.base}/v1/billing/subscriptions`, {
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
   *
   * A coupon becomes a real discount line rather than a quietly smaller
   * number: Orders v2 takes `amount.breakdown.discount`, and PayPal renders it
   * on the approval page and the buyer's receipt. The breakdown must add up —
   * `item_total - discount === amount.value` — or PayPal rejects the order.
   */
  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const token = await this.accessToken();
    const requestId = `REKEY-ORDER-${randomUUID()}`;
    const currency = input.plan.currency;
    const discountMinor = input.discount?.amount ?? 0;
    // Same two-decimal assumption the rest of this class makes (plans and
    // subscriptions both do `amount / 100`).
    const grossMajor = (input.plan.amount / 100).toFixed(2);
    const discountMajor = (discountMinor / 100).toFixed(2);
    const valueMajor = ((input.plan.amount - discountMinor) / 100).toFixed(2);
    // PayPal has no free-form metadata on a purchase unit, so the code goes
    // where the buyer and the operator will both see it.
    const description = (
      input.discount ? `${input.plan.name} (coupon ${input.discount.code})` : input.plan.name
    ).slice(0, 127);
    const res = await paypalFetch(`${this.base}/v2/checkout/orders`, {
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
            description,
            amount: {
              currency_code: currency,
              value: valueMajor,
              ...(input.discount && {
                breakdown: {
                  item_total: { currency_code: currency, value: grossMajor },
                  discount: { currency_code: currency, value: discountMajor },
                },
              }),
            },
            ...(input.discount && {
              items: [
                {
                  name: input.plan.name.slice(0, 127),
                  quantity: '1',
                  unit_amount: { currency_code: currency, value: grossMajor },
                },
              ],
            }),
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
    const res = await paypalFetch(`${this.base}/v2/checkout/orders/${orderId}/capture`, {
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

    const res = await paypalFetch(`${this.base}/v1/notifications/webhooks`, {
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
      const listRes = await paypalFetch(`${this.base}/v1/notifications/webhooks`, {
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
    await paypalFetch(`${this.base}/v1/billing/subscriptions/${providerSubId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Cancelled via Rekey' }),
    });
  }
}

/**
 * The three ways an online verification can end.
 *
 * `unreachable` is separated from `invalid` deliberately. Both used to be
 * `false`, so a PayPal outage or a timeout surfaced as HTTP 401
 * WEBHOOK_SIGNATURE_INVALID — telling PayPal its own signature was bad. PayPal
 * disables an endpoint that keeps rejecting, so an outage on OUR side of the
 * call could cost the operator their webhook. `unreachable` maps to 503, which
 * is retried and reads correctly in the logs.
 *
 * Both are still fail-CLOSED: nothing is processed either way.
 */
export type PaypalVerifyOutcome =
  | { ok: true }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'unreachable' };

/**
 * Verify an inbound PayPal webhook signature.
 *
 * PayPal verification is ONLINE (unlike Stripe's offline HMAC): we POST the
 * transmission headers + the parsed event body + our webhook id to
 * `/v1/notifications/verify-webhook-signature` and trust the
 * `verification_status`. Requires a fresh access token minted from the
 * Application's PayPal client credentials.
 *
 * `{ ok: true }` only on `verification_status === 'SUCCESS'`. A missing
 * transmission header or an explicit non-SUCCESS is `invalid`; a timeout,
 * network error or 5xx from PayPal is `unreachable`.
 *
 * Both calls carry PAYPAL_WEBHOOK_TIMEOUT_MS — see the constant for why this
 * is the sharpest of the eleven calls in this file.
 */
export async function verifyPaypalWebhook(args: {
  creds: PaypalCredentials;
  mode: BillingMode;
  headers: Record<string, string | string[] | undefined>;
  /** The parsed webhook event object (PayPal re-canonicalises server-side). */
  event: unknown;
}): Promise<PaypalVerifyOutcome> {
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
    // Nothing was sent to verify with — that is the caller's problem, not
    // PayPal's availability.
    return { ok: false, reason: 'invalid' };
  }

  // Mint an access token (basic-auth client_credentials).
  const auth = Buffer.from(`${args.creds.clientId}:${args.creds.clientSecret}`).toString('base64');
  let token: string;
  try {
    const tokenRes = await paypalFetch(
      `${base}/v1/oauth2/token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      },
      PAYPAL_WEBHOOK_TIMEOUT_MS,
    );
    // 401/403 here means the operator's stored client credentials are wrong,
    // which is a configuration fault they must fix; anything else is PayPal
    // failing to answer.
    if (!tokenRes.ok) {
      return tokenRes.status === 401 || tokenRes.status === 403
        ? { ok: false, reason: 'invalid' }
        : { ok: false, reason: 'unreachable' };
    }
    token = ((await tokenRes.json()) as { access_token: string }).access_token;
  } catch {
    // Timeout / DNS / connection reset.
    return { ok: false, reason: 'unreachable' };
  }

  try {
    const verifyRes = await paypalFetch(
      `${base}/v1/notifications/verify-webhook-signature`,
      {
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
      },
      PAYPAL_WEBHOOK_TIMEOUT_MS,
    );
    if (!verifyRes.ok) {
      return verifyRes.status >= 500
        ? { ok: false, reason: 'unreachable' }
        : { ok: false, reason: 'invalid' };
    }
    const json = (await verifyRes.json()) as { verification_status?: string };
    return json.verification_status === 'SUCCESS'
      ? { ok: true }
      : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
