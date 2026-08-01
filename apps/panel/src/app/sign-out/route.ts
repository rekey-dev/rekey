/**
 * GET /sign-out
 *
 * Route handler that clears the panel session cookies and redirects to
 * /login. Server components can't write cookies in Next 15 — when
 * `api()` detects an expired session inside an RSC, it redirects here
 * (which CAN delete cookies) instead of trying to clear them inline.
 *
 * Best-effort revoke of the refresh token on the API side so the token
 * can't be re-used by anyone who somehow lifted it. Idempotent — unknown
 * tokens 200.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE, publicPost } from '@/lib/api';

export async function GET(req: NextRequest): Promise<Response> {
  const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
  if (refresh) {
    await publicPost('/api/v1/tenant/auth/sign-out', { refreshToken: refresh }).catch(
      () => undefined,
    );
  }
  const reason = req.nextUrl.searchParams.get('reason');
  const target = reason
    ? `/login?reason=${encodeURIComponent(reason)}`
    : '/login';
  // Emit a RELATIVE Location so the browser resolves it against the public URL
  // it's on (panel.rekey.dev) — NOT `req.url`, which behind a proxy is the
  // internal bind address (e.g. 0.0.0.0:3031). Same pattern as the magic-link /
  // oauth-callback handlers. NextResponse.redirect requires an absolute URL, so
  // set the Location header directly.
  const res = new NextResponse(null, { status: 303, headers: { Location: target } });
  res.cookies.delete(ACCESS_COOKIE);
  res.cookies.delete(REFRESH_COOKIE);
  return res;
}
