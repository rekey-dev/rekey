/**
 * GET /api/auth/magic-link/verify?token=… — consume a magic-link token, set
 * the session cookies, and redirect into the app. This is the URL ReliPay
 * lands the user on (via the templated signInUrl in the request step).
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_OPTS,
  REFRESH_COOKIE_OPTS,
} from '@relipay/nextjs';
import { relipay, RelipayError } from '@/lib/relipay';

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') ?? '';
  const origin = process.env.APP_BASE_URL ?? url.origin;
  if (!token) {
    return NextResponse.redirect(`${origin}/login?error=missing`);
  }
  try {
    const outcome = await relipay.auth.verifyMagicLink({ token });
    if (outcome.mfaRequired) {
      return NextResponse.redirect(`${origin}/login?error=MFA_REQUIRED`);
    }
    const jar = await cookies();
    jar.set(ACCESS_COOKIE, outcome.accessToken, ACCESS_COOKIE_OPTS);
    jar.set(REFRESH_COOKIE, outcome.refreshToken, REFRESH_COOKIE_OPTS);
    return NextResponse.redirect(`${origin}/dashboard`);
  } catch (err) {
    const code = err instanceof RelipayError ? err.code : 'MAGIC_LINK_INVALID';
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(code)}`);
  }
}
