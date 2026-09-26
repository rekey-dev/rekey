import { NextResponse, type NextRequest } from 'next/server';
import { rejectMalformedActionOrigin } from '@rekey.dev/nextjs/middleware';
import { RETURN_TO_HEADER, returnPathOf, staleSessionRedirect } from '@/lib/session-refresh';

const ACCESS_COOKIE = 'rekey_portal_access';
const REFRESH_COOKIE = 'rekey_portal_refresh';

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
 */
export function middleware(req: NextRequest): NextResponse {
  const refused = rejectMalformedActionOrigin(req);
  if (refused) return refused;

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
