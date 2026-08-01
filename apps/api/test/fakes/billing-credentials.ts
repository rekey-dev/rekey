/**
 * Sandbox billing credentials for tests.
 *
 * Checkout no longer falls back to a stub when an Application has no
 * credentials — it refuses with `BILLING_CREDENTIALS_NOT_CONFIGURED`. So any
 * test that drives a checkout has to configure a provider first, exactly like
 * a real operator does. The keys below are fake and never leave the process:
 * `test/setup.ts` swaps in a fake provider, so nothing is dialled.
 *
 * `mode: 'test'` is passed for explicitness, not because anything requires it:
 * an Application's environment does not constrain credential mode, and
 * `resolveMode` would read `test` off the `sk_test_` prefix anyway. Keep it
 * consistent with the key material — a `mode` that contradicts the prefix is
 * refused with `BILLING_CREDENTIALS_MODE_CONTRADICTED`.
 */

import { billingCredentialsService } from '../../src/modules/billing/credentials.service.js';

export async function configureSandboxStripe(applicationId: string): Promise<void> {
  await billingCredentialsService.upsertCredentials(
    applicationId,
    'stripe',
    { apiKey: 'sk_test_ci_only', webhookSecret: 'whsec_ci_only' },
    { mode: 'test' },
  );
}

/**
 * PayPal alongside Stripe, for tests that need the two to behave differently
 * (coupon discounts: Stripe can discount a recurring subscription, PayPal
 * cannot). `mode` is not inferable here — a PayPal sandbox client id is
 * byte-identical to a live one — so it is stated.
 */
export async function configureSandboxPaypal(applicationId: string): Promise<void> {
  await billingCredentialsService.upsertCredentials(
    applicationId,
    'paypal',
    { clientId: 'client_ci_only', clientSecret: 'secret_ci_only', webhookId: 'WH-ci-only' },
    { mode: 'test' },
  );
}
