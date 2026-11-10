import { NextResponse, type NextRequest } from 'next/server';
import { rejectMalformedActionOrigin } from '@rekey.dev/nextjs/middleware';
import { CHECKOUT_PAGE_PROVIDERS, checkoutTokenMode } from '@rekey.dev/shared-types/checkout';
import { RETURN_TO_HEADER, returnPathOf, staleSessionRedirect } from '@/lib/session-refresh';
import {
  buildCheckoutCsp,
  CHECKOUT_CSP_HEADER,
  CHECKOUT_PATH,
  FRAME_GUARD_CSP,
  NONCE_HEADER,
} from '@/lib/checkout-csp';
import { PORTAL_HOST_HEADER, domainName, publicHost } from '@/lib/portal-host';
import { createHostResolver, lookupPortalHost } from '@/lib/host-resolver';
import { isLocalPath } from '@/lib/local-path';

const ACCESS_COOKIE = 'rekey_portal_access';
const TOKEN_LANDING = /^\/[^/]+\/(?:sign-in-link|verify-email|reset-password-link|invitation-link|email-change-link|oauth\/callback|authorize)$/;
const REFRESH_COOKIE = 'rekey_portal_refresh';

/**
 * The token names its payment mode but not its processor, and the session is
 * only read once the page renders, after this header is set. So the policy
 * allows every processor the page hosts, in the token's mode only: a live page
 * still never admits a sandbox host. The page loads only its own session's
 * processor script.
 */

/**
 * The checkout page gets its own treatment: no portal session handling (the
 * buyer arrives from the operator's app, not a portal sign-in), a fresh nonce
 * per request, and a CSP naming only this session's processor and mode.
 */
function checkoutResponse(req: NextRequest, token: string): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCheckoutCsp({ nonce, provider: CHECKOUT_PAGE_PROVIDERS, mode: checkoutTokenMode(token) });
  const headers = requestHeaders(req);
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
 * Four jobs, in this order, all before any page or action runs:
 *
 *   - A Server Action with a malformed `Origin` (the literal `null` an opaque
 *     origin sends) is answered with a 403, where Next would crash on it with
 *     a 500. This comes first, ahead of any redirect. See
 *     `rejectMalformedActionOrigin` in `@rekey.dev/nextjs/middleware` for the
 *     mechanism and why the header is not simply removed.
 *   - A request on an Application's custom domain is mapped onto its slug's
 *     pages (`customDomainResponse`), and the jobs below run on that path.
 *   - A stale session is sent to `/<slug>/session/refresh`: a page request
 *     carrying a refresh cookie but no access cookie (the access cookie's
 *     lifetime is the token's). A render cannot store a rotated token, and
 *     spending one it cannot store gets every session revoked; see
 *     `lib/session-refresh.ts`.
 *   - `X-Rekey-Return-To` is set to the requested path, replacing anything the
 *     client sent, so a render that needs a refresh can name where to return.
 *
 * Checkout paths skip the last two and get `checkoutResponse` instead. The
 * emailed-token landing routes skip them too: they render nothing, and a
 * stale-session redirect would carry their token through the refresh route.
 */
export function middleware(req: NextRequest): NextResponse | Promise<NextResponse> {
  const refused = rejectMalformedActionOrigin(req);
  if (refused) return guardFraming(refused);

  const domain = customDomainOf(req);
  if (domain) return customDomainResponse(req, domain);

  const checkout = CHECKOUT_PATH.exec(req.nextUrl.pathname);
  if (checkout) return checkoutResponse(req, checkout[1]!);
  if (TOKEN_LANDING.test(req.nextUrl.pathname)) {
    return guardFraming(
      req.headers.has(PORTAL_HOST_HEADER) ? NextResponse.next({ request: { headers: requestHeaders(req) } }) : NextResponse.next(),
    );
  }
  return guardFraming(portalResponse(req, req.nextUrl, SHARED_HOST));
}

/** The request's headers, minus any client copy of the custom-domain marker. */
function requestHeaders(req: NextRequest): Headers {
  const headers = new Headers(req.headers);
  headers.delete(PORTAL_HOST_HEADER);
  return headers;
}

/**
 * The host this request asks for, when it is not the shared portal host and
 * could be an Application's verified domain. Null otherwise, and always null
 * without PORTAL_BASE_URL. An IP address or a single-label name is served as
 * the shared host, as every host was before custom domains: the API never
 * verifies one, so it cannot select an Application.
 */
function customDomainOf(req: NextRequest): string | null {
  const base = process.env.PORTAL_BASE_URL;
  if (!base) return null;
  const domain = publicHost(req.headers, process.env.PORTAL_PROXY_SECRET);
  return domain && domain !== domainName(new URL(base).host) ? domain : null;
}

const resolveDomain = createHostResolver((domain) => lookupPortalHost(process.env.REKEY_URL, domain));

/** Served on a custom domain as they are on the shared host: Next's own files. */
const HOST_NEUTRAL_PATH = /^\/(?:_next\/|icon\.png$)/;

/**
 * A request on an Application's custom domain, where the browser's URLs carry
 * no slug. `/x` is rewritten to `/<slug>/x`, so every page and action under
 * `[slug]` runs unchanged. `/<slug>/x`, which those pages link and redirect
 * to, is sent permanently to `/x`. Checkout is sent to the shared host, the
 * only origin the API accepts for it. An unknown host gets an empty 404.
 */
async function customDomainResponse(req: NextRequest, domain: string): Promise<NextResponse> {
  const answer = await resolveDomain(domain);
  if (answer.kind === 'unknown') return guardFraming(bare(404));
  if (answer.kind === 'unavailable') {
    const res = bare(503);
    res.headers.set('Retry-After', '5');
    return guardFraming(res);
  }

  const { pathname, search } = req.nextUrl;
  if (HOST_NEUTRAL_PATH.test(pathname)) return guardFraming(NextResponse.next());
  const home = `/${answer.slug}`;
  const prefixed = pathname === home || pathname.startsWith(`${home}/`);
  const internal = req.nextUrl.clone();
  internal.pathname = prefixed ? pathname : `${home}${pathname === '/' ? '' : pathname}`;

  if (CHECKOUT_PATH.test(internal.pathname)) {
    const res = NextResponse.redirect(`${process.env.PORTAL_BASE_URL!.replace(/\/$/, '')}${internal.pathname}${search}`, 307);
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('Referrer-Policy', 'no-referrer');
    return guardFraming(res);
  }
  if (prefixed) return guardFraming(slugFreeRedirect(req, pathname.slice(home.length)));

  const mode: HostMode = {
    forward: (headers) => {
      headers.set(PORTAL_HOST_HEADER, domain);
      return NextResponse.rewrite(internal, { request: { headers } });
    },
    browserPath: (path) => (path.startsWith(`${home}/`) ? path.slice(home.length) : path),
  };
  if (TOKEN_LANDING.test(internal.pathname)) return guardFraming(mode.forward(requestHeaders(req)));
  return guardFraming(portalResponse(req, internal, mode));
}

/**
 * `rest` (what followed `/<slug>`) with the query, on this host. Checked as a
 * local path after slicing: `/<slug>//evil.example` leaves `//evil.example`,
 * which a browser reads as another host, so anything but a plain local path
 * goes home. `Referrer-Policy` because an emailed link in the old
 * `/<slug>/sign-in-link?token=` form carries its token through this hop.
 */
function slugFreeRedirect(req: NextRequest, rest: string): NextResponse {
  const target = req.nextUrl.clone();
  target.pathname = rest && isLocalPath(rest) ? rest : '/';
  const res = NextResponse.redirect(target, 308);
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

function bare(status: number): NextResponse {
  return new NextResponse(null, { status, headers: { 'Cache-Control': 'no-store' } });
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

/**
 * How a request continues once checked: on the shared host, as itself; on a
 * custom domain, rewritten under its slug, with redirects named by the path
 * the browser sees.
 */
interface HostMode {
  forward(headers: Headers): NextResponse;
  browserPath(path: string): string;
}

const SHARED_HOST: HostMode = {
  forward: (headers) => NextResponse.next({ request: { headers } }),
  browserPath: (path) => path,
};

function portalResponse(req: NextRequest, url: URL, mode: HostMode): NextResponse {
  const refreshAt = staleSessionRedirect({
    method: req.method,
    url,
    hasAccess: !!req.cookies.get(ACCESS_COOKIE)?.value,
    hasRefresh: !!req.cookies.get(REFRESH_COOKIE)?.value,
    fetchDest: req.headers.get('sec-fetch-dest'),
  });
  if (refreshAt) {
    // Resolved against the request: middleware may not answer with a relative
    // Location. Next writes a same-origin redirect back out as a relative one.
    // `no-store` because the redirect depends on the visitor's cookies: a CDN
    // or proxy that cached it would send every visitor round the refresh route.
    const res = NextResponse.redirect(new URL(mode.browserPath(refreshAt), req.nextUrl), 307);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }

  const headers = requestHeaders(req);
  headers.set(RETURN_TO_HEADER, returnPathOf(url));
  return mode.forward(headers);
}

export const config = {
  // Server Actions POST to the page's own path, so the app's routes are the
  // whole surface that matters. Static assets are excluded because they never
  // carry an action and this would otherwise run on every one of them.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|fonts/).*)'],
};
