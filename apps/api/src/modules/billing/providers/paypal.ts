/**
 * PayPal billing provider, real implementation, driven by plain `fetch`.
 *
 * Uses Subscriptions v1 against `/v1/billing/plans` and
 * `/v1/billing/subscriptions` directly. `@paypal/paypal-server-sdk` is still a
 * declared dependency but is deliberately NOT imported here: its billing surface
 * is a thin REST wrapper with awkward types, so it bought nothing over fetch.
 *
 * Mode (`test` → sandbox, `live` → production) selects the API base URL.
 *
 * Webhook verification is delegated to the operator's hosted webhook ID (we
 * call `/v1/notifications/verify-webhook-signature`), see
 * modules/paypal/index.ts (the ProviderModule).
 */

import { randomUUID } from 'node:crypto';
import type { Plan } from '@prisma/client';
import type {
  BillingProvider,
  CancelSubscriptionInput,
  CheckoutSessionInput,
  CheckoutSessionResult,
  EmbeddedCheckoutInput,
  EmbeddedCheckoutResult,
  ProviderOrderSnapshot,
  ProviderPlanRef,
  ProviderSubscriptionSnapshot,
  RefundPaymentInput,
  RefundPaymentResult,
} from './types.js';
import { discountUnsupported } from './discount.js';
import type { PaypalCredentials, BillingMode } from '../credentials.service.js';
import { RekeyError } from '../../../lib/error.js';
import { paypalMajorString, paypalMinorFromMajor } from './paypal-money.js';
import { LIVE_BASE, SANDBOX_BASE, paypalError, paypalFetch } from './paypal-http.js';
import { capturePaypalOrder, createPaypalOrder, readPaypalOrder, type CreatedPaypalOrder, type PaypalApi } from './paypal-orders.js';

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

  private async api(): Promise<PaypalApi> {
    return { base: this.base, token: await this.accessToken() };
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
      {
      const body = await res.text();
      console.error(`paypal token request failed`, res.status, body);
      throw paypalError('token request', res.status, body);
    }
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
    // Ignore non-2xx, most commonly 422 "ALREADY_EXISTS" which we want.

    const requestId = `REKEY-PLAN-${plan.id}`;
    const interval = plan.interval === 'YEAR' ? 'YEAR' : 'MONTH';
    const valueMajor = paypalMajorString(plan.amount, plan.currency);
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
      {
      const body = await planRes.text();
      console.error(`paypal plan creation failed`, planRes.status, body);
      throw paypalError('plan creation', planRes.status, body);
    }
    }
    const planJson = (await planRes.json()) as { id?: string };
    return { providerPlanId: planJson.id ?? requestId };
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    if (input.discount) {
      // Subscriptions v1 has no per-subscription coupon. The only price
      // control at create time is the inline `plan` override, which can just
      // restate the pricing_scheme of a cycle the plan already declares, and
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
    const created = await this.createSubscription(input, input.successUrl, input.cancelUrl);
    return { url: created.approveUrl, sessionId: created.id };
  }

  /**
   * The Rekey-hosted page's subscription or order: created here, server-side,
   * exactly as for the redirect, but PayPal returns the buyer to the Rekey
   * page, which is also where a cancelled approval lands. The page's Buttons
   * only hand this id back through `createSubscription` / `createOrder`, so
   * the browser cannot change the plan, the price or `custom_id`.
   */
  async createEmbeddedCheckout(input: EmbeddedCheckoutInput): Promise<EmbeddedCheckoutResult> {
    if (input.kind === 'one_time') {
      const order = await this.createOrder(input, input.returnUrl, input.returnUrl);
      return {
        sessionId: order.id,
        client: { provider: 'paypal', clientId: this.creds.clientId, orderId: order.id, sdk: 'v5-order', currency: order.currency },
        fallbackUrl: order.approveUrl,
        providerPlanId: null,
      };
    }
    if (input.discount) throw discountUnsupported(this.name, 'recurring');
    const created = await this.createSubscription(input, input.returnUrl, input.returnUrl);
    return {
      sessionId: created.id,
      client: { provider: 'paypal', clientId: this.creds.clientId, subscriptionId: created.id, sdk: 'v5-subscription' },
      fallbackUrl: created.approveUrl,
      providerPlanId: created.planId,
    };
  }

  /**
   * PayPal's own record of one subscription, from this credential set's REST
   * base, so a sandbox id is never read from the live API or the reverse.
   */
  async getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot | null> {
    const token = await this.accessToken();
    const res = await paypalFetch(`${this.base}/v1/billing/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text();
      console.error('paypal subscription read failed', res.status, body);
      throw paypalError('subscription read', res.status, body);
    }
    const sub = (await res.json()) as { id?: unknown; status?: unknown; plan_id?: unknown; custom_id?: unknown };
    return {
      id: typeof sub.id === 'string' ? sub.id : '',
      status: typeof sub.status === 'string' ? sub.status : '',
      planId: typeof sub.plan_id === 'string' ? sub.plan_id : null,
      customId: typeof sub.custom_id === 'string' ? sub.custom_id : null,
    };
  }

  /**
   * PayPal's own record of one Orders v2 order, from this credential set's
   * REST base, so a sandbox order is never read from the live API.
   */
  async getOrder(providerOrderId: string): Promise<ProviderOrderSnapshot | null> {
    return readPaypalOrder(await this.api(), providerOrderId);
  }

  private async createSubscription(
    input: CheckoutSessionInput,
    returnUrl: string,
    cancelUrl: string,
  ): Promise<{ id: string; approveUrl: string; planId: string }> {
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
          return_url: returnUrl,
          cancel_url: cancelUrl,
          user_action: 'SUBSCRIBE_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
        subscriber: input.endUser.email
          ? { email_address: input.endUser.email }
          : undefined,
      }),
    });
    if (!subRes.ok) {
      {
      const body = await subRes.text();
      console.error(`paypal subscription failed`, subRes.status, body);
      throw paypalError('subscription', subRes.status, body);
    }
    }
    const sub = (await subRes.json()) as {
      id: string;
      links: Array<{ rel: string; href: string }>;
    };
    const approve = sub.links.find((l) => l.rel === 'approve');
    if (!approve) {
      throw new Error('PayPal subscription response missing approve link');
    }
    return { id: sub.id, approveUrl: approve.href, planId: paypalPlanId };
  }

  /**
   * One-time purchase via Orders v2 (intent CAPTURE). Returns the approve
   * link; the buyer approves, then the order is captured (see `captureOneTime`,
   * driven by the `CHECKOUT.ORDER.APPROVED` webhook). `custom_id` carries
   * `${appId}:${euId}`; the local row is matched by order id.
   *
   * A coupon becomes a real discount line rather than a quietly smaller
   * number: Orders v2 takes `amount.breakdown.discount`, and PayPal renders it
   * on the approval page and the buyer's receipt. The breakdown must add up,
   * `item_total - discount === amount.value`, or PayPal rejects the order.
   */
  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const order = await this.createOrder(input, input.successUrl, input.cancelUrl);
    return { url: order.approveUrl, sessionId: order.id };
  }

  private async createOrder(
    input: CheckoutSessionInput,
    returnUrl: string,
    cancelUrl: string,
  ): Promise<CreatedPaypalOrder> {
    return createPaypalOrder(await this.api(), input, returnUrl, cancelUrl);
  }

  /**
   * Capture an approved one-time order. Idempotent: an already-captured order
   * counts as success so webhook replays don't error.
   */
  async captureOneTime(orderId: string): Promise<{ captured: boolean }> {
    return capturePaypalOrder(await this.api(), orderId);
  }

  /**
   * Create (or reuse) a PayPal webhook at `publicUrl` subscribed to the events
   * our handler consumes. Returns the webhook id (needed for signature
   * verification). On WEBHOOK_URL_ALREADY_EXISTS the existing webhook is
   * reused and its event types replaced with this set.
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
      // Reversals on the Orders v2 side. An existing webhook picks these up the
      // next time this runs (auto-configure, or saving the credentials).
      'PAYMENT.CAPTURE.REVERSED',
      'PAYMENT.CAPTURE.REFUNDED',
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
    // Already registered for this URL: reuse it, and bring its events up to
    // the set above. A webhook created before one-time checkout existed lacks
    // the order events, and reusing it as-is left approved orders uncaptured.
    if (text.includes('WEBHOOK_URL_ALREADY_EXISTS')) {
      const listRes = await paypalFetch(`${this.base}/v1/notifications/webhooks`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const list = (await listRes.json()) as { webhooks?: Array<{ id: string; url: string }> };
      const match = list.webhooks?.find((w) => w.url === publicUrl);
      if (match) {
        const patch = await paypalFetch(`${this.base}/v1/notifications/webhooks/${encodeURIComponent(match.id)}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([{ op: 'replace', path: '/event_types', value: eventTypes }]),
        });
        if (patch.ok) return { webhookId: match.id };
        const patchText = await patch.text();
        console.error('paypal webhook event update failed', patch.status, patchText);
        throw paypalError('webhook event update', patch.status, patchText);
      }
    }
    console.error('paypal webhook register failed', res.status, text);
    throw paypalError('webhook registration', res.status, text);
  }

  /**
   * Refund a captured PayPal payment.
   *
   * The endpoint is not a constant, and this is the whole difficulty. PayPal
   * has two live refund APIs and the one that applies depends on how the
   * payment was taken:
   *
   *   - Orders v2 one-off checkouts produce a CAPTURE id, refunded at
   *     `POST /v2/payments/captures/{id}/refund`, body `amount.value`.
   *   - Subscriptions produce a SALE id (`PAYMENT.SALE.COMPLETED`), whose
   *     documented refund route is `POST /v1/payments/sale/{id}/refund`, body
   *     `amount.total`. The `/v1/payments` namespace is deprecated but still
   *     live, and PayPal's own current webhook reference still points
   *     `PAYMENT.SALE.REFUNDED` at it.
   *
   * Whether a sale id is ALSO accepted by the v2 captures endpoint is
   * undocumented in both directions. PayPal's subscriptions spec models the
   * transaction as a capture (the status field is titled "Capture Status" and
   * carries the capture enum) and the id formats are identical, which suggests
   * it works; a production gateway explicitly falls back to v1 with the
   * comment that renewals use the v1 Sale resource, which suggests it does
   * not. No PayPal statement settles it.
   *
   * So this does not guess. In order:
   *   1. `input.refundHref`, the `rel:"refund"` link PayPal itself put on
   *      that transaction. It names the right endpoint AND version for that
   *      specific payment, so when we have it the question does not arise.
   *   2. v2 captures.
   *   3. v1 sale, on a 404 from v2, which is exactly the signal that the id
   *      was not in the capture namespace.
   *
   * Note the bodies differ between versions (`amount.value` +
   * `currency_code` vs `amount.total` + `currency`). Crossing them produces a
   * confusing 400 rather than a clear one, so each request builds its own.
   */
  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const token = await this.accessToken();
    const amountMajor =
      input.amount !== undefined ? paypalMajorString(input.amount, input.currency) : null;

    const post = (url: string, body: unknown) =>
      paypalFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          // PayPal keeps the id for 45 days and replays the original result,
          // so a retried refund returns the first refund instead of issuing a
          // second one.
          'PayPal-Request-Id': input.idempotencyKey,
          // Without this PayPal may answer `return=minimal`, id and status
          // only, and the amount we report back would be a guess.
          Prefer: 'return=representation',
        },
        body: JSON.stringify(body),
      });

    // v2 body. An absent amount is a full refund of what remains, which is
    // what an empty payload means to PayPal.
    const v2Body =
      amountMajor === null
        ? {}
        : {
            amount: { value: amountMajor, currency_code: input.currency },
            // `note_to_payer`, NOT `note`. PayPal's own examples show `note`,
            // contradicting their schema; `note` is silently dropped.
            ...(input.reason && { note_to_payer: input.reason.slice(0, 255) }),
          };

    let res: Response;
    if (input.refundHref) {
      res = await post(input.refundHref, v2Body);
    } else {
      res = await post(`${this.base}/v2/payments/captures/${input.providerPaymentId}/refund`, v2Body);
      if (res.status === 404) {
        // Not a capture id. It is a subscription sale id, so use the resource
        // PayPal documents for one. Different field names, deliberately.
        res = await post(`${this.base}/v1/payments/sale/${input.providerPaymentId}/refund`, {
          ...(amountMajor === null
            ? {}
            : { amount: { total: amountMajor, currency: input.currency } }),
          ...(input.reason && { description: input.reason.slice(0, 255) }),
        });
      }
    }

    if (!res.ok) {
      const text = await res.text();
      // The two refusals an operator can act on without opening PayPal. Both
      // arrive as 422 with the meaning in `details[].issue`, matched there
      // rather than on `name`, because PayPal ships both
      // `UNPROCESSABLE_ENTITY` and the misspelled `UNPROCCESSABLE_ENTITY`.
      if (text.includes('REFUND_NOT_ALLOWED_AFTER_180_DAYS')) {
        throw new RekeyError({
          statusCode: 409,
          code: 'BILLING_REFUND_WINDOW_CLOSED',
          message: 'PayPal will not refund a payment more than 180 days old.',
          fix: 'PayPal cannot move this money back. Settle it with the buyer another way, or extend their entitlements instead and resolve the case that way.',
        });
      }
      if (text.includes('CAPTURE_FULLY_REFUNDED')) {
        throw new RekeyError({
          statusCode: 409,
          code: 'BILLING_PAYMENT_ALREADY_REFUNDED',
          message: 'PayPal has already refunded this payment in full.',
          fix: 'Nothing to do, the buyer has their money. Resolve the case as refunded.',
        });
      }
      console.error('paypal refund failed', res.status, text);
      throw paypalError('refund', res.status, text);
    }

    const json = (await res.json()) as {
      id?: string;
      status?: string;
      state?: string;
      amount?: { value?: string; currency_code?: string; total?: string; currency?: string };
    };
    // v2 says `status: COMPLETED`; v1 says `state: completed`. Read both, and
    // treat only an explicit success as success, PayPal returns PENDING for
    // eCheck-funded refunds, where the money has not moved yet.
    const state = (json.status ?? json.state ?? '').toUpperCase();
    const currency = json.amount?.currency_code ?? json.amount?.currency ?? input.currency ?? 'USD';
    const major = json.amount?.value ?? json.amount?.total ?? null;
    return {
      refundId: json.id ?? input.idempotencyKey,
      // PayPal reports money in major units; ours is minor everywhere. Falls
      // back to what we asked for if PayPal's echo is unreadable, which is
      // the honest answer when the refund itself succeeded.
      amount: (major !== null ? paypalMinorFromMajor(major, currency) : null) ?? input.amount ?? 0,
      currency: currency.toUpperCase(),
      status: state === 'COMPLETED' ? 'succeeded' : 'pending',
    };
  }

  /**
   * Cancel the agreement at PayPal. **Always immediately, PayPal has no other
   * kind.**
   *
   * ## Why `input.atPeriodEnd` is not forwarded
   *
   * Subscriptions v1 exposes exactly one cancellation,
   * `POST /v1/billing/subscriptions/:id/cancel`, and it terminates the
   * agreement on the spot. There is no `cancel_at_period_end` (Stripe), no
   * `cancel_at_cycle_end` (Razorpay), and no scheduling parameter of any kind,
   * the request body takes a `reason` string and nothing else. `suspend` is the
   * only neighbouring verb and it means "dunning pause, reactivatable", not
   * "cancel later"; our own webhook translate maps PayPal's SUSPENDED to
   * PAST_DUE and opens a dunning case, so borrowing it here would put a
   * cancelling buyer into collections.
   *
   * So the flag has nowhere to go, and inventing a body field to carry it would
   * be a lie PayPal ignores. This method used to send the same immediate cancel
   * whatever it was asked for, silently, which is defensible as a wire call
   * and indefensible as a promise, because `cancelCurrentSubscription` had
   * already told the buyer "you keep everything you paid for until <date>" and
   * then PayPal's CANCELLED webhook took it away seconds later.
   *
   * ## Where the paid period is honoured instead
   *
   * Cancelling at PayPal NOW is the only thing that reliably stops the money,
   * and stopping the money is the part that cannot be allowed to fail. What it
   * does not have to mean is that entitlements end now: that is Rekey's own
   * decision, not PayPal's. So the period-end promise is kept **locally**,
   * `cancelAt` is recorded, the row stays ACTIVE, `applySubscriptionStatusChanged`
   * declines to let the resulting CANCELLED webhook shorten a period the buyer
   * has paid for, and `expireIfDue` ends it on the day.
   *
   * That ordering is deliberate, and it is the opposite of scheduling the
   * PayPal call for later. Both designs have a failure mode; only one of them
   * costs the buyer money:
   *
   *   - Call PayPal later (a local scheduler): if the sweep is late, missed, or
   *     lands after PayPal's own anniversary, and our period anchor is a local
   *     approximation, so it can, PayPal takes another payment. Money leaves a
   *     buyer's account for a subscription they cancelled.
   *   - Call PayPal now (this): if the local expiry is late, the buyer keeps
   *     access a little longer than they paid for. Costs us, not them.
   *
   * The consequence to be honest about: unlike Stripe's
   * `cancel_at_period_end`, this is not reversible at the provider. Changing
   * their mind means a new agreement, which is what "Resubscribe" does.
   *
   * ## Failures are failures
   *
   * The response used to be discarded entirely. A cancel PayPal refused
   * resolved successfully, `cancelCurrentSubscription` stamped the local row
   * cancelled, and the agreement went on billing, the buyer having been told
   * it was over, and seeing no subscription left to cancel. Throwing surfaces
   * it as `BILLING_PROVIDER_REFUSED` (502) so the buyer knows to try again and
   * the local row is left untouched.
   *
   * 404 / RESOURCE_NOT_FOUND is treated as success on purpose: it is what
   * PayPal answers for an agreement it has already terminated, so a retry after
   * a partial failure settles instead of wedging.
   */
  async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
    const providerSubId = input.subscription.providerSubId;
    if (!providerSubId) return;
    const token = await this.accessToken();
    const res = await paypalFetch(`${this.base}/v1/billing/subscriptions/${providerSubId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Cancelled via Rekey' }),
    });
    if (res.ok || res.status === 404) return;
    const text = await res.text();
    // Already cancelled/expired at PayPal, the outcome we asked for.
    if (res.status === 422 && text.includes('SUBSCRIPTION_STATUS_INVALID')) return;
    console.error('paypal cancel failed', res.status, text);
    throw paypalError('cancellation', res.status, text);
  }
}

export { verifyPaypalWebhook, type PaypalVerifyOutcome } from './paypal-webhook-verify.js';
