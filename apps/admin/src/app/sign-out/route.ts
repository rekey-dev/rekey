import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/cookies';
import { destroySession } from '@/lib/auth';

/**
 * POST-only sign-out: destroys the in-memory session, clears the cookie, then
 * bounces to /login.
 *
 * POST-only is the CSRF guard. A GET handler here would let any third party
 * log the operator out by embedding `<img src="https://admin.relipay.dev/sign-out">`
 * on a page the operator visits. SameSite=Strict on the cookie prevents the
 * sign-out from doing damage (the request would arrive with no session
 * cookie), but the redirect to /login would still kick the operator out of
 * their session. POST-only + a same-origin form means CSRF is structurally
 * blocked: a cross-site POST without the cookie arrives with no session to
 * destroy, and browsers won't auto-submit forms via `<img>`.
 *
 * GET on this route now returns 405 so accidental hits don't quietly
 * log out — and operator-facing tooling sees the explicit method violation.
 */
async function handle(req: NextRequest): Promise<NextResponse> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  destroySession(id);
  // Build the redirect target as an absolute URL anchored on the request's
  // own origin. `NextResponse.redirect` rejects relative-path strings, which
  // is the bug the original implementation hit (it tried to fabricate a path
  // via `new URL(…, 'http://placeholder').toString().replace(…)`, but the
  // result was still a relative string that NextResponse refused → 500).
  const res = NextResponse.redirect(new URL('/login?error=signed_out', req.url));
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // Redundant belt-and-braces: maxAge=0 instructs the browser to delete the
    // cookie immediately, and expires=Date(0) covers older browsers that
    // honour the legacy attribute but ignore Max-Age. Both together = guaranteed
    // delete across the browser matrix.
    maxAge: 0,
    expires: new Date(0),
  });
  return res;
}

export const POST = handle;

/**
 * Explicit 405 on GET so an accidental address-bar hit returns a clear error
 * instead of silently logging out (the old behaviour). Includes the Allow
 * header per RFC 7231.
 */
export function GET(): NextResponse {
  return new NextResponse('Method Not Allowed', {
    status: 405,
    headers: { Allow: 'POST' },
  });
}
