/**
 * GET /<slug>/session/refresh?next=<path>
 *
 * The one place a page load refreshes a portal session. A Server Component
 * cannot write cookies, and spending the single-use refresh token without
 * storing its replacement makes the browser's next request a replay, which the
 * API answers by revoking every session the customer has. So the middleware
 * (access cookie lapsed) and `getPortalUser` (access token refused mid-render)
 * send the browser here. This rotates, writes the new pair onto the redirect,
 * and sends the browser back to `next`, validated to a path inside `/<slug>`.
 *
 * Under `/<slug>` because the session cookies are path-scoped there; the
 * browser would not send them to a route anywhere else.
 *
 * Outcomes:
 *   - rotated: 303 to `next` with both cookies set;
 *   - no refresh cookie: 303 to the sign-in page, touching nothing;
 *   - the API refused: cookies cleared, 303 to the sign-in page with
 *     `reason=expired`;
 *   - the API may have rotated before failing (its own 5xx, a timeout):
 *     cookies cleared, 303 to the sign-in page with
 *     `reason=session_interrupted`;
 *   - 429, a 502/503/504 from a proxy with no Rekey error body (the API
 *     redeploying), a connection that was never made, or a failed portal
 *     config lookup: 503 with Retry-After and the cookies left alone. The
 *     token is unspent, and redirecting back would only send the page here
 *     again;
 *   - a cross-site request (`Sec-Fetch-Site` not `same-origin` or `none`): a
 *     200 page that asks for this URL again from this origin, with no API
 *     call and no cookie touched (see `mayRotateFrom`);
 *   - `REFRESH_TOKEN_RACED` (another tab or instance rotated this token moments
 *     ago; nothing was revoked): 303 back to `next` with the session cookies
 *     untouched, so the browser's next request carries the winner's pair. Only
 *     the loop guard (`RACED_COOKIE`) is set. If the same token races again,
 *     `refreshPortalSession` reports `failed` and the refusal path above runs.
 *
 * Locations are relative so the browser resolves them against the public URL,
 * not the internal bind address a proxied `req.url` carries.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { REFRESH, clearSessionOn, portalClientFor, refreshPortalSession, writeRacedMark, writeSession } from '@/lib/session';
import {
  RACED_COOKIE,
  SESSION_INTERRUPTED_REASON,
  mayRotateFrom,
  refreshDestination,
  refreshInterstitial,
  refreshRoutePath,
} from '@/lib/session-refresh';
import { isPlainSlug } from '@/lib/local-path';
import { PortalConfigUnavailableError } from '@/lib/config';

function seeOther(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

/** The session is intact and the token unspent; reloading this URL tries again. */
function retryLater(retryAfterSeconds: number): NextResponse {
  return new NextResponse('The service is busy. Reload this page in a moment.', {
    status: 503,
    headers: {
      'Retry-After': String(retryAfterSeconds),
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  // Next decodes route params: `/%2Fevil.com/session/refresh` arrives here with
  // slug `/evil.com`, and every Location below starts with `/${slug}`.
  if (!isPlainSlug(slug)) return new NextResponse('Not found', { status: 404 });
  const next = refreshDestination(slug, req.nextUrl.searchParams.get('next'));

  const refresh = req.cookies.get(REFRESH)?.value;
  if (!refresh) return seeOther(`/${slug}/login`);

  if (!mayRotateFrom(req.headers)) {
    return refreshInterstitial(`${refreshRoutePath(slug)}?next=${encodeURIComponent(next)}`);
  }

  let client;
  try {
    client = await portalClientFor(slug);
  } catch (err) {
    // The config lookup failed before any refresh was tried, so the token is
    // unspent: the same retry page as a busy API, cookies untouched.
    if (err instanceof PortalConfigUnavailableError) return retryLater(err.retryAfterSeconds);
    throw err;
  }
  if (!client) return new NextResponse('Not found', { status: 404 });

  const outcome = await refreshPortalSession(client, refresh, req.cookies.get(RACED_COOKIE)?.value);

  if (outcome.kind === 'ok') {
    const res = seeOther(next);
    await writeSession(res.cookies, slug, outcome.fresh.accessToken, outcome.fresh.refreshToken, outcome.fresh);
    return res;
  }

  if (outcome.kind === 'raced') {
    const res = seeOther(next);
    await writeRacedMark(res.cookies, slug, outcome.mark);
    return res;
  }

  if (outcome.kind === 'busy') return retryLater(outcome.retryAfterSeconds);

  const reason = outcome.interrupted ? SESSION_INTERRUPTED_REASON : 'expired';
  const res = seeOther(`/${slug}/login?reason=${reason}`);
  await clearSessionOn(res.cookies, slug);
  return res;
}
