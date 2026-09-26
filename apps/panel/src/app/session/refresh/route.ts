/**
 * GET /session/refresh?next=<path>
 *
 * The one place a page load refreshes a session. A Server Component cannot
 * write cookies, and spending the single-use refresh token without storing its
 * replacement makes the browser's next request a replay, which the API answers
 * by revoking every session the operator has. So the middleware (access cookie
 * lapsed) and `api()` (access token refused mid-render) send the browser here.
 * This rotates, writes the new pair onto the redirect, and sends the browser
 * back to `next`, which is validated to a same-origin path.
 *
 * Outcomes:
 *   - rotated: 303 to `next` with both cookies set;
 *   - no refresh cookie: 303 to /login, touching nothing (a request that
 *     carried no session has no session to clear);
 *   - the API refused: cookies cleared, 303 to /login?reason=expired;
 *   - the API may have rotated before failing (its own 5xx, a timeout):
 *     cookies cleared, 303 to /login?reason=session_interrupted (see
 *     `RefreshOutcome` in lib/api.ts);
 *   - 429, or a 502/503/504 from a proxy with no Rekey error body (the API
 *     redeploying): 503 with Retry-After and the cookies left alone. The token
 *     is unspent, and redirecting back would only send the page here again;
 *   - a cross-site request (`Sec-Fetch-Site` not `same-origin` or `none`): a
 *     200 page that asks for this URL again from this origin, with no API
 *     call and no cookie touched (see `mayRotateFrom` in
 *     lib/session-refresh.ts);
 *   - `REFRESH_TOKEN_RACED` (another tab or instance rotated this token moments
 *     ago; nothing was revoked): 303 back to `next` with the session cookies
 *     untouched, so the browser's next request carries the winner's pair. Only
 *     the loop guard (`RACED_COOKIE`) is set. If the same token races again,
 *     `refreshSessionTokens` reports `failed` and the refusal path above runs.
 *
 * Locations are relative: behind a proxy `req.url` is the internal bind
 * address, so the browser resolves them against the public URL instead.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE, refreshSessionTokens, writeRacedMark, writeSessionCookies } from '@/lib/api';
import {
  REFRESH_ROUTE,
  SESSION_INTERRUPTED_REASON,
  mayRotateFrom,
  refreshDestination,
  refreshInterstitial,
} from '@/lib/session-refresh';

function seeOther(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const next = refreshDestination(req.nextUrl.searchParams.get('next'));

  if (!req.cookies.get(REFRESH_COOKIE)?.value) return seeOther('/login');

  if (!mayRotateFrom(req.headers)) {
    return refreshInterstitial(`${REFRESH_ROUTE}?next=${encodeURIComponent(next)}`);
  }

  const outcome = await refreshSessionTokens();

  if (outcome.kind === 'ok') {
    const res = seeOther(next);
    await writeSessionCookies(res.cookies, outcome.tokens);
    return res;
  }

  if (outcome.kind === 'raced') {
    const res = seeOther(next);
    await writeRacedMark(res.cookies, outcome.mark);
    return res;
  }

  if (outcome.kind === 'busy') {
    return new NextResponse('The Rekey API is busy. Reload this page in a moment.', {
      status: 503,
      headers: {
        'Retry-After': String(outcome.retryAfterSeconds),
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }

  const reason = outcome.interrupted ? SESSION_INTERRUPTED_REASON : 'expired';
  const res = seeOther(`/login?reason=${reason}&next=${encodeURIComponent(next)}`);
  res.cookies.delete(ACCESS_COOKIE);
  res.cookies.delete(REFRESH_COOKIE);
  return res;
}
