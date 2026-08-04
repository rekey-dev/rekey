/**
 * POST /sign-out — and GET, but only from this site.
 *
 * Clears the panel session cookies and redirects to /login. Best-effort revoke
 * of the refresh token API-side so the token can't be re-used by anyone who
 * somehow lifted it. Idempotent — unknown tokens 200.
 *
 * ## Why GET survives here when admin's sign-out is POST-only
 *
 * the super-admin dashboard’s sign-out route answers 405 to GET, and its docblock
 * spells out the attack this route was open to: any third party could log the
 * operator out by embedding `<img src="https://panel.rekey.dev/sign-out">` on a
 * page the operator visits. That is the same bug, in the same repo, fixed on
 * one app and not the other.
 *
 * The panel can't simply copy the POST-only answer, because a GET here is
 * load-bearing: Next 15 forbids cookie writes from a Server Component, so when
 * `api()` finds an expired session mid-render it `redirect()`s to this route —
 * a browser navigation, which is a GET. Making GET a 405 would strand every
 * expired session on a 405 page instead of signing it out.
 *
 * So the guard is `Sec-Fetch-Site` rather than the method. That header is set
 * by the browser, cannot be spoofed by page JavaScript, and states exactly the
 * thing we care about — who initiated this request:
 *
 *   - `same-origin` — our own redirect, our own link, our own form. Allow.
 *   - `same-site`   — another rekey.dev host. Allow.
 *   - `none`        — typed in the address bar or opened from a bookmark. Allow.
 *   - `cross-site`  — an `<img>`, `<iframe>`, `<script>`, `fetch()`, or link on
 *                     someone else's page. This is the attack, and the ONLY
 *                     case we reject.
 *
 * Absent header → allow: every browser capable of mounting this attack sends
 * `Sec-Fetch-Site`, so a request without it is a non-browser client (curl, a
 * health check, a test), which by definition is not being cross-site forged.
 *
 * POST is accepted unconditionally — it is already structurally CSRF-safe here
 * (no cross-site form can be auto-submitted by an `<img>`, and the session
 * cookies are `SameSite=lax`, which withholds them from cross-site POSTs), and
 * it is the method any future sign-out button should use.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE, publicPost } from '@/lib/api';

/** True when the browser says another site initiated this request. */
function isCrossSite(req: NextRequest): boolean {
  return req.headers.get('sec-fetch-site') === 'cross-site';
}

async function signOut(req: NextRequest): Promise<Response> {
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

export async function GET(req: NextRequest): Promise<Response> {
  if (isCrossSite(req)) {
    // Deliberately does NOT sign out, and deliberately does not redirect: a
    // redirect would still yank an operator out of the panel, which is the
    // whole point of the attack. 405 + Allow: POST mirrors the admin app's
    // answer so the two routes read the same way.
    return new NextResponse('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }
  return signOut(req);
}

export const POST = signOut;
