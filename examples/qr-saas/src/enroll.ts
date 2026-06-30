/**
 * Free-plan enrollment.
 *
 * ReliPay has **no** auto-assigned default plan: a subscription only becomes
 * ACTIVE when the billing provider's webhook fires (see
 * apps/api/.../webhooks/stripe.handler.ts — checkout creates a PENDING row,
 * the webhook flips it ACTIVE + provisions entitlements). There is no $0/free
 * immediate-activation shortcut in the API.
 *
 * Consequence for a freemium tier: even the $0 Free plan must be a *real* ACTIVE
 * subscription for its USAGE quota to be enforced. Without one,
 * `entitlements.includedQuotaFor` finds no ACTIVE sub → returns `null` →
 * `usage.record` treats the meter as uncapped, so a Free user's `qr_scans` are
 * never blocked (only subscribed Pro users get capped — backwards). See issue
 * #63.
 *
 * The fix uses only mechanisms the API actually supports: `billing.createCheckout`
 * on the $0 plan → the stub provider's `checkout.session.completed` webhook,
 * signed offline with the app's BYO webhook secret (no real Stripe round-trip,
 * the same path apps/api/test/stripe-webhook.test.ts exercises). That yields a
 * genuine ACTIVE Free subscription, so the existing server-side hard cap (402
 * USAGE_QUOTA_EXCEEDED) enforces the monthly scan allowance — no client-side
 * cap duplication, and identical to how Pro is enforced.
 */

import type { ReliPay } from '@relipay/node';
import { RelipayError } from '@relipay/node';
import type { QrSaasConfig } from './bootstrap.js';
import { completeCheckoutViaWebhook } from './stripe-webhook.js';
import { PLAN_FREE } from './constants.js';

/**
 * Activate a plan for the calling subject end-to-end: checkout (stub) → signed
 * Stripe webhook → ACTIVE + entitlements provisioned. Works for any plan kind,
 * including the $0 Free plan. When `organizationId` is given the subscription is
 * bought for that org (owner+beneficiary), so the quota pools to the team.
 */
export async function activatePlan(
  relipay: ReliPay,
  config: QrSaasConfig,
  accessToken: string,
  planSlug: string,
  organizationId?: string,
): Promise<void> {
  const checkout = await relipay.billing.createCheckout(accessToken, {
    planSlug,
    successUrl: 'https://qr.example/ok',
    cancelUrl: 'https://qr.example/cancel',
    ...(organizationId ? { organizationId } : {}),
  });
  const sessionId = (checkout.subscription.metadata as { checkoutSessionId?: string }).checkoutSessionId;
  if (!sessionId) {
    throw new Error(`checkout for "${planSlug}" returned no checkoutSessionId — cannot complete activation`);
  }
  await completeCheckoutViaWebhook({
    apiUrl: config.apiUrl,
    appSlug: config.applicationSlug,
    webhookSecret: config.stripeWebhookSecret,
    applicationId: config.applicationId,
    checkoutSessionId: sessionId,
  });
}

/**
 * Ensure a freshly signed-up user is enrolled in the $0 Free plan so its USAGE
 * quota (qr_scans) is enforced. Idempotent: a no-op when the subject already
 * holds an ACTIVE subscription. Best-effort — never throws, so a hiccup in the
 * stub-webhook dance can't block sign-up. A user who somehow isn't enrolled just
 * falls back to the old uncapped behavior (no regression) until their next
 * enrollment attempt; the Free QR-count cap still applies client-side regardless.
 *
 * Personal subject: pass only `accessToken`. Org subject (billingSubject='org',
 * or a team workspace): also pass `organizationId` so the org pool is enrolled.
 */
export async function ensureFreePlan(
  relipay: ReliPay,
  config: QrSaasConfig,
  accessToken: string,
  organizationId?: string,
): Promise<void> {
  try {
    // Skip when the subject is already entitled: for the personal subject a
    // current subscription means we're done; for an org we check the org's
    // resolved entitlements (no "current sub" endpoint for the pool).
    if (organizationId) {
      const ent = await relipay.billing.getEntitlements(accessToken, { organizationId });
      if (ent.entitlements.length > 0) return;
    } else {
      const sub = await relipay.billing.getSubscription(accessToken);
      if (sub) return;
    }
    await activatePlan(relipay, config, accessToken, PLAN_FREE, organizationId);
  } catch (e) {
    // Don't let enrollment failure break sign-up / org creation. Log + move on.
    const reason = e instanceof RelipayError ? `${e.code}: ${e.message}` : String(e);
    console.warn(`[qr-saas] free-plan enrollment skipped: ${reason}`);
  }
}
