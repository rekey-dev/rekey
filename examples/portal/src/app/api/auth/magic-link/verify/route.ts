/**
 * GET /api/auth/magic-link/verify?token=… — consume a magic-link token, set
 * the httpOnly session cookies, redirect into the portal. This is the URL
 * ReliPay templates into the email link (see requestMagicLinkAction).
 * Mirrors examples/nextjs-saas.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_OPTS,
  REFRESH_COOKIE_OPTS,
} from '@relipay/nextjs';
import { portalBaseUrl } from '@/lib/env';
import { relipay, RelipayError } from '@/lib/relipay';

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') ?? '';
  const origin = portalBaseUrl();
  if (!token) {
    return NextResponse.redirect(`${origin}/login?error=missing`);
  }
  try {
    const outcome = await relipay.auth.verifyMagicLink({ token });
    if (outcome.mfaRequired) {
      // A consumed magic link IS a possession factor, but the API still asks
      // for the second factor — portal v1 punts (same as password sign-in).
      return NextResponse.redirect(`${origin}/login?error=MFA_REQUIRED`);
    }
    const jar = await cookies();
    jar.set(ACCESS_COOKIE, outcome.accessToken, ACCESS_COOKIE_OPTS);
    jar.set(REFRESH_COOKIE, outcome.refreshToken, REFRESH_COOKIE_OPTS);
    return NextResponse.redirect(`${origin}/subscription`);
  } catch (err) {
    const code = err instanceof RelipayError ? err.code : 'MAGIC_LINK_INVALID';
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(code)}`);
  }
}
