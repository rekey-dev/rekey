/**
 * GET /refresh-session?return=<encoded-path>
 *
 * Route handler that exchanges the refresh cookie for a fresh access/refresh
 * pair, writes them as cookies, and redirects to `?return=...` (or `/`).
 *
 * Server components can't write cookies in Next 15, so when `requireUser`
 * detects an expired access token it redirects here. We do the work in a
 * route handler — which can write cookies — and then bounce back.
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  rekey,
  RekeyError,
} from '@/lib/relipay';

const ONE_DAY = 60 * 60 * 24;

export async function GET(req: NextRequest): Promise<Response> {
  const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
  const returnTo = req.nextUrl.searchParams.get('return') ?? '/';
  const safeReturn = returnTo.startsWith('/') ? returnTo : '/';

  if (!refresh) {
    return new NextResponse(null, { status: 303, headers: { location: '/sign-out?reason=expired' } });
  }

  try {
    const fresh = await rekey.auth.refresh(refresh);
    // Relative Location — resolves against the public host, not the internal
    // bind address `req.url` carries behind a proxy.
    const res = new NextResponse(null, { status: 303, headers: { location: safeReturn } });
    const secure = process.env.NODE_ENV === 'production';
    res.cookies.set(ACCESS_COOKIE, fresh.accessToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      path: '/',
      maxAge: 60 * 15,
    });
    res.cookies.set(REFRESH_COOKIE, fresh.refreshToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      path: '/',
      maxAge: ONE_DAY * 30,
    });
    return res;
  } catch (err) {
    void (err instanceof RekeyError);
    return new NextResponse(null, { status: 303, headers: { location: '/sign-out?reason=expired' } });
  }
}
