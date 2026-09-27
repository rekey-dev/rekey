import { NextResponse, type NextRequest } from 'next/server';
import { rejectMalformedActionOrigin } from '@rekey.dev/nextjs/middleware';
import { checkoutTokenMode } from '@rekey.dev/shared-types/checkout';
import { RETURN_TO_HEADER, returnPathOf, staleSessionRedirect } from '@/lib/session-refresh';
import {
  buildCheckoutCsp,
  CHECKOUT_CSP_HEADER,
  CHECKOUT_PATH,
  FRAME_GUARD_CSP,
  NONCE_HEADER,
} from '@/lib/checkout-csp';

const ACCESS_COOKIE = 'rekey_portal_access';
const REFRESH_COOKIE = 'rekey_portal_refresh';

/**
 * Phase 1 serves PayPal only, and the token does not name its processor. The
 * page itself refuses to load processor scripts for any other provider.
 */
const CHECKOUT_PAGE_PROVIDER = 'paypal';

/**
 * The checkout page gets its own treatment: no portal session handling (the
 * buyer arrives from the operator's app, not a portal sign-in), a fresh nonce
 * per request, and a CSP naming only this session's processor and mode.
 */
function checkoutResponse(req: NextRequest, token: string): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCheckoutCsp({ nonce, provider: CHECKOUT_PAGE_PROVIDER, mode: checkoutTokenMode(token) });
  const headers = new Headers(req.headers);
  headers.set(NONCE_HEADER, nonce);
  // Next reads the nonce for its own scripts from the REQUEST's
  // `content-security-policy` header, falling back to the report-only one,
  // and a response CSP set below reaches that lookup too. So the full policy
  // goes on the enforcing request header name whatever the response sends,
  // or the frame guard's nonce-less policy wins and Next's scripts ship
  // without a nonce.
  headers.set('content-security-policy', csp);
  headers.set(CHECKOUT_CSP_HEADER.toLowerCase(), csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set(CHECKOUT_CSP_HEADER, csp);
  // No second, enforcing Content-Security-Policy on this response: Next takes
  // the nonce for its own scripts from a response CSP set here in preference
  // to the request header above, so a nonce-less frame guard strips every
  // Next script of its nonce (seen in a real render). While the page policy
  // only reports, `X-Frame-Options: DENY` (next.config.mjs) refuses framing.
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return res;
}

/**
 * Three jobs, in this order, all before any page or action runs:
 *
 *   - A Server Action with a malformed `Origin` (the literal `null` an opaque
 *     origin sends) is answered with a 403, where Next would crash on it with
 *     a 500. This comes first, ahead of any redirect. See
 *     `rejectMalformedActionOrigin` in `@rekey.dev/nextjs/middleware` for the
 *     mechanism and why the header is not simply removed.
 *   - A stale session is sent to `/<slug>/session/refresh`: a page request
 *     carrying a refresh cookie but no access cookie (the access cookie's
 *     lifetime is the token's). A render cannot store a rotated token, and
 *     spending one it cannot store gets every session revoked; see
 *     `lib/session-refresh.ts`.
 *   - `X-Rekey-Return-To` is set to the requested path, replacing anything the
 *     client sent, so a render that needs a refresh can name where to return.
 *
 * Checkout paths skip the last two and get `checkoutResponse` instead.
 */
export function middleware(req: NextRequest): NextResponse {
  const refused = rejectMalformedActionOrigin(req);
  if (refused) return guardFraming(refused);

  const checkout = CHECKOUT_PATH.exec(req.nextUrl.pathname);
  if (checkout) return checkoutResponse(req, checkout[1]!);
  return guardFraming(portalResponse(req));
}

/**
 * Every portal response refuses to be framed. Set here rather than in
 * next.config.mjs so the checkout page's own policy is the only
 * Content-Security-Policy it carries once that policy enforces.
 */
function guardFraming(res: NextResponse): NextResponse {
  res.headers.set('Content-Security-Policy', FRAME_GUARD_CSP);
  return res;
}

function portalResponse(req: NextRequest): NextResponse {
  const refreshAt = staleSessionRedirect({
    method: req.method,
    url: req.nextUrl,
    hasAccess: !!req.cookies.get(ACCESS_COOKIE)?.value,
    hasRefresh: !!req.cookies.get(REFRESH_COOKIE)?.value,
    fetchDest: req.headers.get('sec-fetch-dest'),
  });
  if (refreshAt) {
    // Resolved against the request: middleware may not answer with a relative
    // Location. Next writes a same-origin redirect back out as a relative one.
    // `no-store` because the redirect depends on the visitor's cookies: a CDN
    // or proxy that cached it would send every visitor round the refresh route.
    const res = NextResponse.redirect(new URL(refreshAt, req.nextUrl), 307);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }

  const headers = new Headers(req.headers);
  headers.set(RETURN_TO_HEADER, returnPathOf(req.nextUrl));
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Server Actions POST to the page's own path, so the app's routes are the
  // whole surface that matters. Static assets are excluded because they never
  // carry an action and this would otherwise run on every one of them.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|fonts/).*)'],
};
