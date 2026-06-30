import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/cookies';

/**
 * Edge gate for the admin surface.
 *
 * Bounces every page request without a session cookie to /login. The cookie
 * is opaque — the real session validation runs in the (authed) layout via
 * `validateSession()`, which can also expire it. Edge middleware is just the
 * cheap "no cookie at all → don't render" guard.
 *
 * Static assets, the login page itself, and the login API route stay open.
 */
export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const hasCookie = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (!hasCookie) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Match everything except static assets, the login page + its API, and
  // /sign-out (which clears the cookie). Order matters — keep `_next/static`
  // first so it short-circuits the regex.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|login|api/login|sign-out|fonts/).*)',
  ],
};
