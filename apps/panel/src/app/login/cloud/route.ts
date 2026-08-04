/**
 * Land a buyer in the panel from the site that already signed them in.
 *
 * rekey.dev holds the buyer's Rekey Cloud session. It obtains an OIDC ID Token
 * for them server-side (see the app-authorised session handoff,
 * `POST /api/v1/mcp/:slug/oauth/authorize/grant`) and posts it here. We hand it
 * to the API, which verifies it against the deployment's own JWKS and returns
 * an operator session.
 *
 * **POST, not GET, and that is load-bearing.** The ID Token is a bearer
 * assertion. In a query string it would sit in browser history, in the
 * `Referer` of every subsequent request, and in any proxy log along the way. In
 * a form body it is none of those. rekey.dev renders a self-submitting form
 * rather than issuing a redirect for exactly this reason — the same POST
 * binding SAML has used for the same problem for twenty years.
 *
 * The token is single-use and short-lived on the API side, so a replay of a
 * captured body fails there rather than depending on anything here.
 *
 * A Route Handler (not a page) because this must set cookies and redirect, and
 * server components can do neither.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { publicPost, PanelApiError, ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/api';
import { cookieSecure } from '@/lib/cookie-secure';

type AssertResult =
  | { mfaRequired: true; mfaChallengeToken: string }
  | { mfaRequired: false; accessToken: string; refreshToken: string };

const ACCESS_MAX_AGE = 60 * 15; // 15 min — mirrors setSessionCookies
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Relative Location — the browser resolves it against the public URL it is on
// (panel.rekey.dev), NOT `req.url`, which behind a proxy is the internal bind
// address. NextResponse.redirect requires an absolute URL, so emit the header
// directly. Same reasoning as the OAuth callback next door.
function seeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let idToken = '';
  try {
    const form = await req.formData();
    idToken = String(form.get('id_token') ?? '');
  } catch {
    // Not a form body at all.
    return seeOther('/login?error=cloud_handoff');
  }
  if (!idToken) return seeOther('/login?error=cloud_handoff');

  let result: AssertResult;
  try {
    result = await publicPost<AssertResult>('/api/v1/tenant/auth/oidc/assert', { idToken });
  } catch (err) {
    if (err instanceof PanelApiError) {
      // The API answers one code for every reason an assertion is refused, so
      // there is nothing to disclose here beyond "that link did not work".
      // `OIDC_ASSERTION_NOT_CONFIGURED` lands here too, which is correct: on a
      // deployment that accepts no assertions this route simply does not work.
      return seeOther(`/login?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }

  // An MFA-enrolled operator still gets the challenge. Federating the primary
  // factor does not dissolve the second one.
  if (result.mfaRequired) {
    return seeOther(`/mfa-verify?challenge=${encodeURIComponent(result.mfaChallengeToken)}`);
  }

  const secure = await cookieSecure();
  const res = seeOther('/applications?e=login_cloud');
  res.cookies.set(ACCESS_COOKIE, result.accessToken, {
    httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: ACCESS_MAX_AGE,
  });
  res.cookies.set(REFRESH_COOKIE, result.refreshToken, {
    httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: REFRESH_MAX_AGE,
  });
  return res;
}

/**
 * A GET here is always a mistake worth handling deliberately: either someone
 * bookmarked the landing URL, or a token was put in a query string somewhere
 * it should not have been. Send them to sign in rather than 405-ing.
 */
export function GET(): NextResponse {
  return seeOther('/login');
}
