/**
 * Next.js middleware helpers.
 *
 * `relipayMiddleware({ publicRoutes, signInUrl })` returns a middleware
 * function the user wires up in their `middleware.ts`. It:
 *   - Lets `publicRoutes` pass through unauthenticated.
 *   - For protected routes, requires the access cookie. Missing → redirect
 *     to `signInUrl` with a `next` query param so the user lands back here
 *     after sign-in.
 *
 * This middleware is intentionally simple — it does not call ReliPay over
 * the network on every request. Token validity is verified the next time
 * the customer's server uses it via `auth()` or directly. The cookie's
 * presence is the gate; the cookie's *value* is checked deeper in the stack.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE } from './cookies.js';

export interface MiddlewareConfig {
  /** Routes that don't require auth. Strings or RegExp; matched against pathname. */
  publicRoutes?: Array<string | RegExp>;
  /** Where to send unauthenticated users. Defaults to /sign-in. */
  signInUrl?: string;
}

function matches(pathname: string, patterns: Array<string | RegExp>): boolean {
  return patterns.some((p) =>
    typeof p === 'string' ? pathname === p || pathname.startsWith(p + '/') : p.test(pathname),
  );
}

export function relipayMiddleware(config: MiddlewareConfig = {}) {
  const publicRoutes = config.publicRoutes ?? [
    '/sign-in',
    '/sign-up',
    '/forgot-password',
    '/reset-password',
    '/api/auth',
  ];
  const signInUrl = config.signInUrl ?? '/sign-in';

  return function middleware(req: NextRequest): NextResponse {
    const { pathname } = req.nextUrl;
    if (matches(pathname, publicRoutes)) return NextResponse.next();

    const access = req.cookies.get(ACCESS_COOKIE)?.value;
    if (access) return NextResponse.next();

    const url = req.nextUrl.clone();
    url.pathname = signInUrl;
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  };
}
