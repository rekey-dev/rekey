import { NextResponse, type NextRequest } from 'next/server';
import { sanitizedActionHeaders } from '@/lib/server-action-origin';
import { forwardingHeaders, trustedProxyHops } from '@/lib/client-ip';

/**
 * Two request-header repairs, both applied before any page or action runs:
 *
 *   - A malformed `Origin` is removed so it cannot crash a Server Action. See
 *     `server-action-origin.ts` for the mechanism and why the header is removed
 *     rather than rewritten.
 *   - `X-Forwarded-For` is believed only from the configured proxy (it must
 *     present `PANEL_PROXY_SECRET`), and is then reduced to the one client
 *     address. Otherwise it is removed, so Next fills it from the socket. It
 *     also records whether the address left is the visitor's, which decides
 *     whether `X-Rekey-Client-Ip` goes to the API. See `client-ip.ts`.
 */
export function middleware(req: NextRequest): NextResponse {
  const afterOrigin = sanitizedActionHeaders(req);
  const headers = forwardingHeaders(afterOrigin ?? req.headers, {
    hops: trustedProxyHops(),
    secret: process.env.PANEL_PROXY_SECRET,
  });
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Server Actions POST to the page's own path, so the app's routes are the
  // whole surface that matters. Static assets are excluded because they never
  // carry an action and this would otherwise run on every one of them.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|fonts/).*)'],
};
