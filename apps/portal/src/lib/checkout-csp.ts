/**
 * The Content-Security-Policy for the checkout page.
 *
 * Nonce-based and per request: only scripts carrying this request's nonce, and
 * the active processor's own origins, may run. Nothing else loads on a page
 * that hosts a payment form, which is the SAQ A condition that no script on
 * the page can tamper with the processor's frames.
 *
 * The processor origins come from the same table the API's provider module
 * declares (`@rekey.dev/shared-types/checkout`). The payment mode is read from
 * the token's visible prefix: a token whose prefix was edited finds no session,
 * so the prefix a rendered page carries is always the session's real mode.
 */

import {
  CHECKOUT_BROWSER_ORIGINS,
  type CheckoutBrowserOrigins,
  type CheckoutPaymentMode,
} from '@rekey.dev/shared-types/checkout';

/** Where the page's browsers send CSP violation reports, on the portal itself. */
export const CSP_REPORT_PATH = '/checkout-csp-report';

/** The header name while the policy is rolled out; switches to the enforcing name before GA. */
export const CHECKOUT_CSP_HEADER: string = 'Content-Security-Policy-Report-Only';
const ENFORCING = CHECKOUT_CSP_HEADER === 'Content-Security-Policy';

const NONE: CheckoutBrowserOrigins = { scriptSrc: [], frameSrc: [], connectSrc: [], imgSrc: [], styleSrc: [] };

/**
 * @example
 * buildCheckoutCsp({ nonce: 'abc', provider: 'paypal', mode: 'test' });
 * // "default-src 'none'; script-src 'self' 'nonce-abc' https://*.paypal.com …; frame-ancestors 'none'; …"
 */
export function buildCheckoutCsp(args: {
  nonce: string;
  provider: string | null;
  mode: CheckoutPaymentMode | null;
}): string {
  const origins =
    args.provider !== null && args.mode !== null ? (CHECKOUT_BROWSER_ORIGINS[args.provider]?.[args.mode] ?? NONE) : NONE;
  const nonce = `'nonce-${args.nonce}'`;
  const directives: Array<[string, readonly string[]]> = [
    ['default-src', ["'none'"]],
    ['script-src', ["'self'", nonce, ...origins.scriptSrc]],
    ['frame-src', origins.frameSrc.length > 0 ? origins.frameSrc : ["'none'"]],
    ['connect-src', ["'self'", ...origins.connectSrc]],
    ['img-src', ["'self'", 'data:', 'https:']],
    ['style-src', ["'self'", nonce, ...origins.styleSrc]],
    ['font-src', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['object-src', ["'none'"]],
    // Browsers ignore this directive, loudly, in a report-only policy.
    ...(ENFORCING ? [['upgrade-insecure-requests', []] as [string, readonly string[]]] : []),
    ['report-uri', [CSP_REPORT_PATH]],
  ];
  return directives.map(([name, values]) => (values.length > 0 ? `${name} ${values.join(' ')}` : name)).join('; ');
}

/** The portal's policy outside the checkout page: refuse to be framed. */
export const FRAME_GUARD_CSP = "frame-ancestors 'none'";

/** Request header the middleware sets and the checkout page reads its nonce from. */
export const NONCE_HEADER = 'x-nonce';

/** `/<slug>/checkout/<token>` and anything beneath it. */
export const CHECKOUT_PATH = /^\/[^/]+\/checkout\/([^/]+)(?:\/|$)/;
