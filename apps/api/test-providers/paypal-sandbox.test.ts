/**
 * PayPal sandbox — plan registration, checkout, and the one verification path
 * the ordinary test suite structurally cannot reach.
 *
 * That last one is the reason this file exists. PayPal does not sign webhooks
 * with an offline HMAC the way Stripe and Razorpay do: verification is an
 * ONLINE call to `/v1/notifications/verify-webhook-signature`. The shared
 * pipeline skips exactly that under `NODE_ENV=test`
 * (`capabilities.onlineVerify && !isProduction && NODE_ENV === 'test'`), which
 * is correct — a unit suite must not depend on PayPal being up — but it means
 * `verifyPaypalWebhook` has never once been executed against PayPal by any
 * test in this repository.
 *
 * So this suite calls the module's `verify` DIRECTLY, bypassing the pipeline
 * skip, and asserts that PayPal refuses a payload we made up. A verifier that
 * fails open would pass every existing test and hand an attacker the money
 * path; only a real call can tell the difference.
 *
 * PayPal cannot discount a recurring subscription — the module declares
 * `discounts: { oneTime: true, recurring: false }` — so the coupon assertions
 * here are about the refusal, not about a discounted total.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { plansService } from '../src/modules/plans/plans.service.js';
import { couponsService } from '../src/modules/coupons/coupons.service.js';
import { describeSandbox, paypalSandbox, PAYPAL_WEBHOOK_ID_VAR } from './support/credentials.js';
import { HARNESS_PREFIX, newRunId } from './support/naming.js';
import {
  closeSandboxApp,
  configureProvider,
  createFixture,
  startCheckout,
} from './support/fixture.js';

describeSandbox('paypal', 'PayPal sandbox', paypalSandbox, (creds) => {
  let runId: string;

  beforeAll(() => {
    runId = newRunId();
  });

  afterAll(async () => {
    // PayPal sandbox plans and products cannot be deleted through the REST
    // API — a plan can only be DEACTIVATED. Everything created here is
    // therefore named with the harness prefix and left inactive rather than
    // removed, which is the most a caller can do. Documented in
    // docs/provider-sandbox-testing.md so nobody is surprised by the residue.
    await closeSandboxApp();
  });

  async function paypalFixture(label: string) {
    const fixture = await createFixture(label);
    await configureProvider(fixture, 'paypal', {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      webhookId: creds.webhookId ?? '',
    });
    return fixture;
  }

  it('registers a plan and mints a real approval URL', async () => {
    const fixture = await paypalFixture('pp-checkout');

    // PayPal registers lazily at first checkout — `plansService.create` only
    // eager-registers when STRIPE credentials exist. So the plan is created
    // NOT_REQUIRED and the provider round-trip happens below.
    const plan = await plansService.create({
      applicationId: fixture.applicationId,
      slug: 'pp-monthly',
      name: `${HARNESS_PREFIX} PayPal ${runId}`,
      amount: 1500,
      currency: 'USD',
      interval: 'MONTH',
    });
    expect(plan.registrationStatus).toBe('NOT_REQUIRED');

    const res = await startCheckout(fixture, { planSlug: 'pp-monthly', provider: 'paypal' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { url: string; provider: string };
    expect(data.provider).toBe('paypal');
    // A sandbox approval link, from PayPal's own `links` array — proof the
    // OAuth token exchange, the plan create and the subscription create all
    // succeeded against api-m.sandbox.paypal.com.
    expect(data.url).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);

    // Pinning current behaviour, and it is worth staring at: `createCheckoutSession`
    // READS `plan.metadata.paypal.planId` and falls back to
    // `ensurePlanRegistered` when it is missing — but NOTHING ever writes that
    // key. Only the Stripe path persists a provider plan id (via
    // `registerAndSettle`). So every PayPal checkout re-registers the plan,
    // relying on `PayPal-Request-Id` idempotency to dedupe, and once that
    // window lapses a second billing plan is created for the same Rekey plan.
    // Asserted rather than fixed here: this file is a harness, and the fix is
    // a product change that wants its own review.
    const stored = await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });
    expect((stored.metadata as { paypal?: { planId?: string } }).paypal?.planId).toBeUndefined();
  });

  it('refuses a recurring coupon rather than silently charging full price', async () => {
    const fixture = await paypalFixture('pp-coupon');
    await plansService.create({
      applicationId: fixture.applicationId,
      slug: 'pp-discount',
      name: `${HARNESS_PREFIX} PayPal Coupon ${runId}`,
      amount: 2000,
      currency: 'USD',
      interval: 'MONTH',
    });
    await couponsService.create({
      applicationId: fixture.applicationId,
      code: `${HARNESS_PREFIX}-pp-10`,
      discountType: 'AMOUNT',
      amountOff: 200,
      currency: 'USD',
    });

    const res = await startCheckout(fixture, {
      planSlug: 'pp-discount',
      provider: 'paypal',
      couponCode: `${HARNESS_PREFIX}-pp-10`,
    });
    // The refusal is local (`checkout-discount.ts`) and happens before PayPal
    // is dialled — but it is asserted HERE, in the suite with real
    // credentials, because the failure mode it guards is "the provider
    // silently ignored the discount", which only a real provider can exhibit.
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('BILLING_DISCOUNT_UNSUPPORTED');
  });

  it('PayPal itself rejects a forged webhook — the online verifier fails closed', async () => {
    if (!creds.webhookId) {
      throw new Error(
        `This assertion needs a sandbox webhook id. Set ${PAYPAL_WEBHOOK_ID_VAR} — see ` +
          'docs/provider-sandbox-testing.md for how to create one.',
      );
    }
    const { paypalModule } = await import(
      '../src/modules/billing/providers/modules/paypal/index.js'
    );

    // Headers shaped exactly like PayPal's, carrying a signature over nothing.
    const forged = {
      id: `WH-${runId}`,
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: { id: 'I-FORGED', status: 'ACTIVE' },
    };
    const result = await paypalModule.webhook.verify(
      {
        rawBody: JSON.stringify(forged),
        headers: {
          'paypal-transmission-id': `${runId}-transmission`,
          'paypal-transmission-time': new Date().toISOString(),
          'paypal-transmission-sig': 'not-a-real-signature',
          'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FORGED',
          'paypal-auth-algo': 'SHA256withRSA',
        },
        payload: forged,
        params: {},
      },
      {
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        webhookId: creds.webhookId,
      },
      { mode: 'test' },
    );

    expect(result.ok).toBe(false);
    // A 503 here would mean we could not REACH PayPal, which is a different
    // failure and must not be mistaken for "the forgery was rejected".
    expect(result.ok === false && result.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });
});
