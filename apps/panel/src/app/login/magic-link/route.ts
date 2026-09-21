/**
 * Magic-link verify. The operator's sign-in link points here
 * (/login/magic-link?token=…). The token IS the credential (single-use,
 * 15-min), possession is the auth factor, so no CSRF cookie is needed (same
 * posture as the password-reset link). Exchange it via the API, set the session
 * cookies, and land in the panel.
 *
 * A Route Handler (not a page) because it must set cookies + redirect.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { publicPost, PanelApiError, ACCESS_COOKIE, REFRESH_COOKIE, sessionCookieMaxAges } from '@/lib/api';
import { cookieSecure } from '@/lib/cookie-secure';

type VerifyResult =
  | { mfaRequired: true; mfaChallengeToken: string }
  | { mfaRequired: false; accessToken: string; refreshToken: string; accessTokenExpiresAt: string; refreshTokenExpiresAt: string };


// Redirect with a RELATIVE Location so the browser resolves it against the
// public URL it's on (panel.rekey.dev), NOT `req.url`, which behind a proxy
// is the internal bind address (e.g. 0.0.0.0:3031). NextResponse.redirect
// requires an absolute URL, so emit the header directly.
function seeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = new URL(req.url).searchParams.get('token');
  if (!token) return seeOther('/login?error=magic_link_missing');

  let result: VerifyResult;
  try {
    result = await publicPost<VerifyResult>('/api/v1/tenant/auth/magic-link/verify', { token });
  } catch (err) {
    if (err instanceof PanelApiError) {
      return seeOther(`/login?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }

  // MFA-enrolled operator → hand off to the verify page with the challenge.
  if (result.mfaRequired) {
    return seeOther(`/mfa-verify?challenge=${encodeURIComponent(result.mfaChallengeToken)}`);
  }

  const secure = await cookieSecure();
  const res = seeOther('/applications');
  const maxAges = sessionCookieMaxAges(result);
  res.cookies.set(ACCESS_COOKIE, result.accessToken, {
    httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: maxAges.access,
  });
  res.cookies.set(REFRESH_COOKIE, result.refreshToken, {
    httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: maxAges.refresh,
  });
  return res;
}
