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
 * wrong one for a marketing page — list them, or scope the matcher.
 *
 * This middleware is intentionally simple — it does not call Rekey over
 * the network on every request. Token validity is verified the next time
 * the customer's server uses it via `auth()` or directly. The cookie's
 * presence is the gate; the cookie's *value* is checked deeper in the stack.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './cookies.js';

export interface MiddlewareConfig {
  /** Routes that don't require auth. Strings or RegExp; matched against pathname. */
  publicRoutes?: Array<string | RegExp>;
  /** Where to send unauthenticated users. Defaults to /sign-in. */
  signInUrl?: string;
  /**
   * Route that exchanges the refresh cookie for a new session, for the case
   * below. Defaults to `/api/rekey/refresh`; set `false` to opt out.
   *
   * A visitor holding a refresh token but no access token is not signed out,
   * they are stale — the access cookie lives fifteen minutes and the refresh
   * cookie thirty days, so this is every user, several times a day. They
   * cannot be repaired by a page: refreshing writes cookies, which Next
   * forbids during a render, and spending a refresh token that cannot be
   * stored makes the API revoke every session the user has.
   *
   * So the gate sends them through a route handler, which may write. Create
   * one that calls `refreshSession()` from `@rekey.dev/nextjs/server` and
   * redirects to `next`.
   */
  refreshUrl?: string | false;
}

function matches(pathname: string, patterns: Array<string | RegExp>): boolean {
  return patterns.some((p) =>
    typeof p === 'string' ? pathname === p || pathname.startsWith(p + '/') : p.test(pathname),
  );
}

export function rekeyMiddleware(config: MiddlewareConfig = {}) {
  const signInUrl = config.signInUrl ?? '/sign-in';
  const publicRoutes = config.publicRoutes ?? [
    '/sign-in',
    '/sign-up',
    '/forgot-password',
    '/reset-password',
    '/api/auth',
  ];

  /**
   * The destination is always public, whatever the caller passed.
   *
   * `publicRoutes` REPLACES the default list rather than extending it, so a
   * caller who supplies their own — the common case, since the default
   * protects the whole site — can easily omit the page they are redirecting
   * to. Naming a custom `signInUrl` does it too. The result is a request to
   * the sign-in page being redirected to the sign-in page until the browser
   * gives up, with nothing in any log to say why.
   *
   * There is no configuration in which protecting the sign-in page is what
   * somebody wanted, so this is not a default worth letting them override.
   */
  const refreshUrl = config.refreshUrl === false ? null : (config.refreshUrl ?? '/api/rekey/refresh');

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

  return function middleware(req: NextRequest): NextResponse {
    const { pathname, search } = req.nextUrl;
    const access = req.cookies.get(ACCESS_COOKIE)?.value;

    // Stale rather than signed out: repair it before anything renders. Checked
    // ahead of the public-route test, because a public page reading `auth()`
    // wants the session too.
    if (!access && refreshUrl && !pathname.startsWith(refreshUrl)) {
      const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
      if (refresh) {
        const url = req.nextUrl.clone();
        url.pathname = refreshUrl;
        url.search = '';
        url.searchParams.set('next', `${pathname}${search}`);
        return NextResponse.redirect(url);
      }
    }

    if (matches(pathname, gateExempt)) return NextResponse.next();
    if (access) return NextResponse.next();

    const url = req.nextUrl.clone();
    url.pathname = signInUrl;
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  };
}
