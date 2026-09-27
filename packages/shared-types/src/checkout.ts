/**
 * Facts about the Rekey-hosted checkout page that the API and the portal must
 * agree on. Dependency-free, so the portal's middleware can import it.
 */

/** Payment mode of a checkout, from the mode of its provider's credentials. */
export type CheckoutPaymentMode = 'test' | 'live';

/**
 * A checkout page token: `chk_test_` or `chk_live_` and 32 random bytes in
 * base64url. The prefix is descriptive only; the whole string is what is
 * hashed and looked up, so a token whose prefix was edited finds nothing.
 *
 * @example
 * CHECKOUT_TOKEN_PATTERN.test('chk_live_' + 'A'.repeat(43)); // true
 */
export const CHECKOUT_TOKEN_PATTERN = /^chk_(test|live)_[A-Za-z0-9_-]{43}$/;

/**
 * The payment mode a well-formed token names, or null for anything else.
 *
 * @example
 * checkoutTokenMode('chk_test_' + 'A'.repeat(43)); // 'test'
 * checkoutTokenMode('nope'); // null
 */
export function checkoutTokenMode(token: string): CheckoutPaymentMode | null {
  const match = CHECKOUT_TOKEN_PATTERN.exec(token);
  if (!match) return null;
  return match[1] === 'live' ? 'live' : 'test';
}

/** Browser origins one processor's embedded component needs, per CSP directive. */
export interface CheckoutBrowserOrigins {
  scriptSrc: readonly string[];
  frameSrc: readonly string[];
  connectSrc: readonly string[];
  imgSrc: readonly string[];
  styleSrc: readonly string[];
}

/**
 * Test mode: PayPal's published CSP set, whose wildcards cover the sandbox
 * hosts, plus the sandbox host named explicitly.
 */
const PAYPAL_TEST = [
  'https://*.paypal.com',
  'https://*.paypalobjects.com',
  'https://*.venmo.com',
  'https://www.sandbox.paypal.com',
] as const;

/**
 * Live mode: exact production hosts, no wildcard, because `*.paypal.com`
 * also matches `www.sandbox.paypal.com` and a live page must never load the
 * sandbox. The report-only period is where a missing host shows up.
 */
const PAYPAL_LIVE = [
  'https://www.paypal.com',
  'https://c.paypal.com',
  'https://t.paypal.com',
  'https://www.paypalobjects.com',
  'https://www.venmo.com',
] as const;

function paypalOrigins(hosts: readonly string[]): CheckoutBrowserOrigins {
  return { scriptSrc: hosts, frameSrc: hosts, connectSrc: hosts, imgSrc: hosts, styleSrc: hosts };
}

/**
 * Per processor and payment mode, the origins the checkout page's CSP allows.
 * No live list may match a sandbox host; `test/checkout-origins.test.ts`
 * holds that.
 */
export const CHECKOUT_BROWSER_ORIGINS: Readonly<
  Record<string, Readonly<Record<CheckoutPaymentMode, CheckoutBrowserOrigins>>>
> = {
  paypal: {
    test: paypalOrigins(PAYPAL_TEST),
    live: paypalOrigins(PAYPAL_LIVE),
  },
};

/** The eight readiness checks, in the order the panel shows them. */
export const CHECKOUT_READINESS_CHECK_IDS = [
  'portal',
  'provider',
  'webhook',
  'plans',
  'return_urls',
  'browser_credential',
  'branding',
  'csp_reports',
] as const;
export type CheckoutReadinessCheckId = (typeof CHECKOUT_READINESS_CHECK_IDS)[number];
