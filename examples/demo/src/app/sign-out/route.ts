/**
 * GET /sign-out
 *
 * Route handler that clears the session cookies and redirects to /sign-in.
 * Server components can't write cookies (Next 15) so they redirect here
 * when they detect an expired/invalid session.
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  getRefreshToken,
  rekey,
} from '@/lib/relipay';

export async function GET(req: NextRequest): Promise<Response> {
  // Best-effort revoke on the API side. Idempotent — unknown tokens 200.
  const refresh = await getRefreshToken();
  if (refresh) {
    await rekey.auth.signOut(refresh).catch(() => undefined);
  }

  const reason = req.nextUrl.searchParams.get('reason');
  const target = reason
    ? `/sign-in?reason=${encodeURIComponent(reason)}`
    : '/';
  // Relative Location so the browser resolves it against the public host, not
  // `req.url` (the internal bind address behind a proxy, e.g. 0.0.0.0:3032).
  const res = new NextResponse(null, { status: 303, headers: { location: target } });
  res.cookies.delete(ACCESS_COOKIE);
  res.cookies.delete(REFRESH_COOKIE);
  return res;
}
