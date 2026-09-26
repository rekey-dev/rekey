/**
 * Next.js middleware helpers.
 *
 * `rekeyMiddleware({ publicRoutes, signInUrl })` returns a middleware
 * function the user wires up in their `middleware.ts`. It:
 *   - Lets `publicRoutes` pass through unauthenticated, plus `signInUrl`,
 *     which is exempt whether or not the caller listed it.
 *   - For protected routes, requires the access cookie. Missing → redirect
 *     to `signInUrl` with a `next` query param so the user lands back here
 *     after sign-in.
 *
 * Note that supplying `publicRoutes` REPLACES the default list. Everything
 * not named is protected, which is the right default for a dashboard and the
 * wrong one for a marketing page, list them, or scope the matcher.
 *
 * This middleware is intentionally simple, it does not call Rekey over
 * the network on every request. Token validity is verified the next time
 * the customer's server uses it via `auth()` or directly. The cookie's
 * presence is the gate; the cookie's *value* is checked deeper in the stack.
 *
 * A Server Action whose `Origin` is not a URL (the literal `null` a sandboxed
 * iframe or other opaque origin sends) is refused with a 403 before anything
 * else, instead of crashing inside Next. See `action-origin.ts`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './cookies.js';
import { rejectMalformedActionOrigin } from './action-origin.js';
import { DEFAULT_REFRESH_PATH, DEFAULT_SIGN_IN_PATH } from './paths.js';

export { rejectMalformedActionOrigin, MALFORMED_ACTION_ORIGIN_MESSAGE } from './action-origin.js';
export { DEFAULT_REFRESH_PATH, DEFAULT_SIGN_IN_PATH } from './paths.js';
export type { ActionRequestLike } from './action-origin.js';

export interface MiddlewareConfig {
  /** Routes that don't require auth. Strings or RegExp; matched against pathname. */
  publicRoutes?: Array<string | RegExp>;
  /** Where to send unauthenticated users. Defaults to /sign-in. */
  signInUrl?: string;
  /**
   * Route that exchanges the refresh cookie for a new session, for the case
   * below. Defaults to `/api/rekey/refresh`; set `false` to opt out.
   *
   * Only GET and HEAD are redirected; other methods pass through and refresh
   * in place with `auth()` or `refreshSession()`, which may write cookies in
   * a Server Action or route handler.
   *
   * A visitor holding a refresh token but no access token is not signed out,
   * they are stale, the access cookie lives fifteen minutes and the refresh
   * cookie thirty days, so this is every user, several times a day. They
   * cannot be repaired by a page: refreshing writes cookies, which Next
   * forbids during a render, and spending a refresh token that cannot be
   * stored makes the API revoke every session the user has.
   *
   * So the gate sends them through a route handler, which may write, with
   * the path they asked for in `next`. Create it with one line:
   * `export const GET = rekeyRefreshHandler();` from `@rekey.dev/nextjs/server`
   * in `app/api/rekey/refresh/route.ts` (see `DEFAULT_REFRESH_PATH`).
   */
  refreshUrl?: string | false;
}

function matches(pathname: string, patterns: Array<string | RegExp>): boolean {
  return patterns.some((p) =>
    typeof p === 'string' ? pathname === p || pathname.startsWith(p + '/') : p.test(pathname),
  );
}

export function rekeyMiddleware(config: MiddlewareConfig = {}) {
  const signInUrl = config.signInUrl ?? DEFAULT_SIGN_IN_PATH;
  const publicRoutes = config.publicRoutes ?? [
    DEFAULT_SIGN_IN_PATH,
    '/sign-up',
    '/forgot-password',
    '/reset-password',
    '/api/auth',
  ];

  /**
   * The destination is always public, whatever the caller passed.
   *
   * `publicRoutes` REPLACES the default list rather than extending it, so a
   * caller who supplies their own, the common case, since the default
   * protects the whole site, can easily omit the page they are redirecting
   * to. Naming a custom `signInUrl` does it too. The result is a request to
   * the sign-in page being redirected to the sign-in page until the browser
   * gives up, with nothing in any log to say why.
   *
   * There is no configuration in which protecting the sign-in page is what
   * somebody wanted, so this is not a default worth letting them override.
   */
  const refreshUrl = config.refreshUrl === false ? null : (config.refreshUrl ?? DEFAULT_REFRESH_PATH);

  /**
   * The two destinations the gate must never protect, whatever the caller
   * passed: the page it redirects to, and the route that repairs a session.
   * Guarding either sends the request to something that sends it back.
   */
  const gateExempt: Array<string | RegExp> = [
    ...publicRoutes,
    signInUrl,
    ...(refreshUrl ? [refreshUrl] : []),
  ];

  /** Let the request through unchanged. */
  const pass = (_req: NextRequest): NextResponse => NextResponse.next();

  return function middleware(req: NextRequest): NextResponse {
    // First, ahead of every redirect, so an action from an opaque origin gets
    // the same refusal whether its sender is signed in, stale or signed out.
    const refused = rejectMalformedActionOrigin(req);
    if (refused) return refused;

    const { pathname, search } = req.nextUrl;
    const access = req.cookies.get(ACCESS_COOKIE)?.value;

    // Stale rather than signed out: repair it before anything renders. Checked
    // ahead of the public-route test, because a public page reading `auth()`
    // wants the session too.
    //
    // Only page loads take the hop. A Server Action or any other non-GET is
    // let through instead: a redirect would drop its body, the refresh route
    // answers GET only, and the action can refresh in place, since `auth()`
    // and `refreshSession()` may write cookies there.
    if (!access && refreshUrl && !pathname.startsWith(refreshUrl)) {
      const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
      if (refresh && req.method !== 'GET' && req.method !== 'HEAD') return pass(req);
      if (refresh) return uncachedRedirect(req, refreshUrl, `${pathname}${search}`);
    }

    if (matches(pathname, gateExempt)) return pass(req);
    if (access) return pass(req);

    return uncachedRedirect(req, signInUrl, `${pathname}${search}`);
  };
}

/**
 * A redirect to `to?next=<returnTo>` that nothing may cache.
 *
 * Both of the gate's redirects depend on the visitor's cookies, not on the
 * URL, so a shared cache that stored one would send every later visitor to
 * the refresh route or the sign-in page, signed in or not. `no-store` says so.
 *
 * `returnTo` keeps the page's query. Next has already removed its `_rsc`
 * cache-buster from `req.nextUrl` before middleware runs, so it cannot be
 * carried; the client-side fetch that follows these redirects still sends
 * its `RSC` headers, and Next answers the final page with `Vary` on them.
 * The hops themselves are `no-store`, so no cache holds a flight response
 * under this HTML URL on our account.
 */
function uncachedRedirect(req: NextRequest, to: string, returnTo: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = to;
  url.search = '';
  url.searchParams.set('next', returnTo);
  const res = NextResponse.redirect(url);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
