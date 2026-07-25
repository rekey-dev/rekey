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
 * Stub is preserved for tests / missing-creds dev runs.
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
} from './types.js';
import type { RazorpayCredentials } from '../credentials.service.js';

export class RealRazorpayProvider implements BillingProvider {
  readonly name = 'razorpay';
  private readonly client: Razorpay;

  constructor(creds: RazorpayCredentials) {
    this.client = new Razorpay({
      key_id: creds.keyId,
      key_secret: creds.keySecret,
    });
  }

  async ensurePlanRegistered(plan: Plan): Promise<ProviderPlanRef> {
    const period = plan.interval === 'YEAR' ? 'yearly' : 'monthly';
    // Razorpay needs amount in the smallest currency unit (paise for INR,
    // cents for USD) — same as ours, so no conversion.
    const created = await this.client.plans.create({
      period,
      interval: 1,
      item: {
        name: plan.name,
        amount: plan.amount,
        currency: plan.currency,
      },
      notes: { relipay_plan_id: plan.id, relipay_slug: plan.slug },
    });
    return { providerPlanId: (created as { id: string }).id };
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const meta = (input.plan.metadata as Record<string, unknown> | null) ?? {};
    const rzpMeta = (meta.razorpay as { planId?: string } | undefined) ?? {};
    let rzpPlanId = rzpMeta.planId;
    if (!rzpPlanId) {
      rzpPlanId = (await this.ensurePlanRegistered(input.plan)).providerPlanId;
    }

    // Razorpay Subscription create. `total_count: 12` = 12 billing cycles
    // (Razorpay requires a finite count for subscriptions API). For an
    // indefinite sub we pick a large number; the operator can cancel any time.
    const sub = await this.client.subscriptions.create({
      plan_id: rzpPlanId,
      total_count: input.plan.interval === 'YEAR' ? 10 : 120,
      customer_notify: 1,
      notes: {
        relipay_end_user_id: input.endUser.id,
        relipay_plan_id: input.plan.id,
      },
    });
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
   */
  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    // The razorpay SDK's paymentLink.create types are over-strict (demand
    // options/customer) and its return type is noisy — cast to a loose
    // signature, same posture as plans/subscriptions create above.
    const create = this.client.paymentLink.create as (body: unknown) => Promise<unknown>;
    const link = (await create({
      amount: input.plan.amount,
      currency: input.plan.currency,
      accept_partial: false,
      description: input.plan.name,
      callback_url: input.successUrl,
      callback_method: 'get',
      notes: {
        relipay_application_id: input.application.id,
        relipay_end_user_id: input.endUser.id,
        relipay_plan_id: input.plan.id,
      },
    })) as { id: string; short_url: string };
    return { url: link.short_url, sessionId: link.id };
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
    const providerSubId = input.subscription.providerSubId;
    if (!providerSubId) return;
    await this.client.subscriptions.cancel(providerSubId, !input.atPeriodEnd /* cancel_at_cycle_end */);
  }
}

/** Fallback used in tests / when creds are missing. Deterministic stub URLs. */
export class RazorpayStubProvider implements BillingProvider {
  readonly name = 'razorpay';
  async ensurePlanRegistered(plan: Plan): Promise<ProviderPlanRef> {
    return { providerPlanId: `plan_stub_${plan.slug}` };
  }
  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const sessionId = `sub_stub_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const url = `${input.successUrl}${input.successUrl.includes('?') ? '&' : '?'}stub_provider=razorpay&stub_session=${sessionId}`;
    return { url, sessionId };
  }
  async createOneTimeCheckout(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    const sessionId = `plink_stub_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const url = `${input.successUrl}${input.successUrl.includes('?') ? '&' : '?'}stub_provider=razorpay&stub_plink=${sessionId}`;
    return { url, sessionId };
  }
  async cancelSubscription(_input: CancelSubscriptionInput): Promise<void> {
    /* no-op */
  }
}
