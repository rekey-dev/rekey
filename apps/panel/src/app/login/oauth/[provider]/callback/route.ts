/**
 * Operator OAuth callback. The provider redirects the browser here after
 * consent. We verify the one-shot CSRF `state` cookie set by the login page's
 * startOAuth action, exchange the code via the API (which mints the operator
 * session), then set the session cookies and land in the panel.
 *
 * A Route Handler (not a page) because this is a provider GET redirect that
 * must set cookies + redirect — server components can't set cookies.
 */

import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import { publicPost, PanelApiError, ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/api';

type CallbackResult =
  | { mfaRequired: true; mfaChallengeToken: string }
  | { mfaRequired: false; accessToken: string; refreshToken: string };

const ACCESS_MAX_AGE = 60 * 15; // 15 min — mirrors setSessionCookies
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Relative Location — the browser resolves it against the public URL it's on
// (panel.relipay.dev), NOT `req.url`, which behind a proxy is the internal bind
// address (e.g. 0.0.0.0:3031). NextResponse.redirect requires an absolute URL,
// so emit the header directly.
function seeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await ctx.params;
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  // The provider sends `error` (e.g. access_denied) when the user cancels.
  const providerError = url.searchParams.get('error');

  const jar = await cookies();
  const cookieState = jar.get('oauth_state')?.value;
  const cookieProvider = jar.get('oauth_provider')?.value;

  const fail = (errCode: string): NextResponse => {
    const res = seeOther(`/login?error=${encodeURIComponent(errCode)}`);
    res.cookies.delete('oauth_state');
    res.cookies.delete('oauth_provider');
    return res;
  };

  if (providerError) return fail('oauth_denied');
  // CSRF: the returned state must match the cookie we set on start, for THIS
  // provider. A missing/mismatched cookie means a forged or stale callback.
  if (!code || !state || !cookieState || state !== cookieState || cookieProvider !== provider) {
    return fail('oauth_state');
  }

  let result: CallbackResult;
  try {
    result = await publicPost<CallbackResult>(
      `/api/v1/tenant/auth/oauth/${encodeURIComponent(provider)}/callback`,
      { code },
    );
  } catch (err) {
    if (err instanceof PanelApiError) return fail(err.code);
    throw err;
  }

  // MFA-enrolled operator → hand off to the verify page with the challenge.
  if (result.mfaRequired) {
    const res = seeOther(`/mfa-verify?challenge=${encodeURIComponent(result.mfaChallengeToken)}`);
    res.cookies.delete('oauth_state');
    res.cookies.delete('oauth_provider');
    return res;
  }

  const secure = process.env.NODE_ENV === 'production';
  const res = seeOther('/applications?e=login_oauth');
  res.cookies.set(ACCESS_COOKIE, result.accessToken, {
    httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: ACCESS_MAX_AGE,
  });
  res.cookies.set(REFRESH_COOKIE, result.refreshToken, {
    httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: REFRESH_MAX_AGE,
  });
  res.cookies.delete('oauth_state');
  res.cookies.delete('oauth_provider');
  return res;
}
