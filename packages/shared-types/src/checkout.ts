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
  /** Where the page may POST a form, for a processor whose fallback is a form post. */
  formAction: readonly string[];
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
  return { scriptSrc: hosts, frameSrc: hosts, connectSrc: hosts, imgSrc: hosts, styleSrc: hosts, formAction: [] };
}

/**
 * Stripe's published CSP list for Stripe.js (3-D Secure frames on
 * `hooks.stripe.com`) plus Link, from docs.stripe.com/security/guide. Test and
 * live use the same hosts: Stripe tells the modes apart by key, not by host.
 * `maps.googleapis.com` is left out because it is only for the Address
 * Element, which the page does not mount.
 */
const STRIPE_ORIGINS: CheckoutBrowserOrigins = {
  scriptSrc: ['https://js.stripe.com', 'https://*.js.stripe.com'],
  frameSrc: ['https://js.stripe.com', 'https://*.js.stripe.com', 'https://hooks.stripe.com', 'https://link.com', 'https://*.link.com'],
  connectSrc: ['https://api.stripe.com', 'https://link.com', 'https://*.link.com'],
  imgSrc: ['https://*.stripe.com', 'https://*.link.com'],
  styleSrc: [],
  formAction: [],
};

/**
 * The Stripe.js release train the checkout page loads
 * (`https://js.stripe.com/<train>/stripe.js`). It must be the train of the
 * API version the API pins, which the API's tests hold.
 */
export const STRIPE_JS_RELEASE_TRAIN = 'endive';

/** Query parameter Stripe returns the buyer to the checkout page with; Stripe fills in the session id. */
export const STRIPE_RETURN_PARAM = 'stripe_session_id';

/**
 * A Stripe Checkout Session id as the page and the API accept it.
 *
 * @example
 * STRIPE_CHECKOUT_SESSION_ID_PATTERN.test('cs_test_a1B2'); // true
 */
export const STRIPE_CHECKOUT_SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/;

/**
 * Razorpay serves test and live from the same hosts; the key id's prefix picks
 * the mode. `api.razorpay.com` is the modal's frame and the Hosted Checkout
 * form target the one-time fallback posts to.
 */
const RAZORPAY: CheckoutBrowserOrigins = {
  scriptSrc: ['https://checkout.razorpay.com'],
  frameSrc: ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
  connectSrc: ['https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://lumberjack.razorpay.com'],
  imgSrc: ['https://cdn.razorpay.com'],
  styleSrc: ['https://checkout.razorpay.com'],
  formAction: ['https://api.razorpay.com'],
};

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
  razorpay: { test: RAZORPAY, live: RAZORPAY },
  stripe: { test: STRIPE_ORIGINS, live: STRIPE_ORIGINS },
};

/** Every processor the checkout page has a payment region for. */
export const CHECKOUT_PAGE_PROVIDERS: readonly string[] = Object.keys(CHECKOUT_BROWSER_ORIGINS);

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

/**
 * A PayPal subscription or order id as the checkout page may report it: what
 * PayPal issues, and nothing that could change the path it is read from.
 *
 * @example
 * PAYPAL_RESOURCE_ID_PATTERN.test('I-BW452GLLEP1G'); // true
 */
export const PAYPAL_RESOURCE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * What the checkout page posts once PayPal has approved: the subscription id
 * for a subscription checkout, the order id for a one-time one.
 */
export type PaypalApprovalBody = { subscriptionId: string } | { orderId: string };

/**
 * The approval body in an untrusted value, or null: exactly one of the two
 * keys, holding a well-formed id, and nothing else.
 *
 * @example
 * parsePaypalApproval({ orderId: '5O190127TN364715T' }); // { orderId: '5O190127TN364715T' }
 * parsePaypalApproval({ orderId: 'x', subscriptionId: 'y' }); // null
 */
export function parsePaypalApproval(body: unknown): PaypalApprovalBody | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const entries = Object.entries(body);
  if (entries.length !== 1) return null;
  const [key, value] = entries[0]!;
  if (typeof value !== 'string' || !PAYPAL_RESOURCE_ID_PATTERN.test(value)) return null;
  if (key === 'subscriptionId') return { subscriptionId: value };
  if (key === 'orderId') return { orderId: value };
  return null;
}

/** What Razorpay's checkout `handler` (or Hosted Checkout's callback) returns for a paid subscription or order. */
export type RazorpayPaymentResponse =
  | { paymentId: string; signature: string; subscriptionId: string }
  | { paymentId: string; signature: string; orderId: string };

export const RAZORPAY_PAYMENT_ID = /^pay_[A-Za-z0-9]{1,40}$/;
export const RAZORPAY_SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{1,40}$/;
export const RAZORPAY_ORDER_ID = /^order_[A-Za-z0-9]{1,40}$/;
/** Hex HMAC-SHA256. */
export const RAZORPAY_SIGNATURE = /^[a-f0-9]{64}$/;

/**
 * The response, when every field is well formed and exactly one of the
 * subscription and order ids is present; otherwise null.
 *
 * @example
 * parseRazorpayResponse({ paymentId: 'pay_1', orderId: 'order_1', signature: 'ab…' }); // { paymentId, orderId, signature }
 * parseRazorpayResponse({ paymentId: 'pay_1', signature: 'ab…' }); // null
 */
export function parseRazorpayResponse(input: {
  paymentId?: unknown;
  signature?: unknown;
  subscriptionId?: unknown;
  orderId?: unknown;
}): RazorpayPaymentResponse | null {
  const { paymentId, signature, subscriptionId, orderId } = input;
  if (typeof paymentId !== 'string' || !RAZORPAY_PAYMENT_ID.test(paymentId)) return null;
  if (typeof signature !== 'string' || !RAZORPAY_SIGNATURE.test(signature)) return null;
  if (subscriptionId !== undefined && orderId !== undefined) return null;
  if (typeof subscriptionId === 'string' && RAZORPAY_SUBSCRIPTION_ID.test(subscriptionId)) {
    return { paymentId, signature, subscriptionId };
  }
  if (typeof orderId === 'string' && RAZORPAY_ORDER_ID.test(orderId)) return { paymentId, signature, orderId };
  return null;
}
