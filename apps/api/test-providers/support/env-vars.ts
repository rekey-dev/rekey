/**
 * The environment variables the sandbox harness reads.
 *
 * Their own module, with NO vitest import, because `global-setup.ts` needs the
 * names for its banner and vitest's global setup runs in a different context —
 * importing anything that pulls in `describe`/`expect` there fails the run with
 * "Vitest failed to access its internal state".
 *
 * The names deliberately do NOT match anything the API itself reads. There is
 * no deployment-wide Stripe key in Rekey — credentials are per-Application and
 * BYO (see `providers/index.ts`) — so a bare `STRIPE_SECRET_KEY` in the
 * environment would be a variable the product does not have and must not learn
 * to want. Every name below says TEST or SANDBOX and belongs to the harness.
 */

/** Stripe **test-mode** secret key (`sk_test_…`). */
export const STRIPE_KEY_VAR = 'STRIPE_TEST_SECRET_KEY';
/** PayPal **sandbox** REST app client id. */
export const PAYPAL_CLIENT_ID_VAR = 'PAYPAL_SANDBOX_CLIENT_ID';
/** PayPal **sandbox** REST app client secret. */
export const PAYPAL_CLIENT_SECRET_VAR = 'PAYPAL_SANDBOX_CLIENT_SECRET';
/** PayPal sandbox webhook id — needed for the ONLINE signature verifier. */
export const PAYPAL_WEBHOOK_ID_VAR = 'PAYPAL_SANDBOX_WEBHOOK_ID';
/** Razorpay **test-mode** key id (`rzp_test_…`). */
export const RAZORPAY_KEY_ID_VAR = 'RAZORPAY_TEST_KEY_ID';
/** Razorpay **test-mode** key secret. */
export const RAZORPAY_KEY_SECRET_VAR = 'RAZORPAY_TEST_KEY_SECRET';
/** Opt-in flag for the browser-driven Checkout completion. */
export const BROWSER_VAR = 'REKEY_SANDBOX_BROWSER';
/** Comma-separated providers whose absence must FAIL rather than skip. */
export const REQUIRE_VAR = 'REKEY_SANDBOX_REQUIRE';
/** Path the harness writes its skip log to, for the closing banner. */
export const SKIP_LOG_VAR = 'REKEY_SANDBOX_SKIP_LOG';
