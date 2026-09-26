/**
 * Where a stale session is refreshed, and how a request gets there.
 *
 * The refresh token is single-use and rotates on every exchange. The API reads
 * a replay of a rotated token as theft and revokes every session the operator
 * has, on every device. So a refresh must only ever happen where the new pair
 * can be written back to the browser: a Server Action or a Route Handler.
 * A Server Component render cannot write cookies (Next 15 throws), so a render
 * that finds a dead access token never refreshes. It redirects here instead,
 * and `app/session/refresh/route.ts` rotates, writes the cookies and sends the
 * browser back to the page it asked for.
 *
 * The middleware does the same before anything renders when the access cookie
 * has lapsed (its lifetime is the token's), which is the common case. The
 * render-time redirect covers the rest: an access cookie still present but
 * refused by the API.
 *
 * Pure and runtime-neutral (no `Buffer`, no `next/headers`): the middleware
 * runs on the edge runtime and imports it too.
 */

import { safeNext } from './safe-next';

export const REFRESH_ROUTE = '/session/refresh';

/**
 * The path and query the browser asked for, stamped on every request by the
 * middleware (which overwrites any value the client sent), so a Server
 * Component can name its own URL in the refresh redirect.
 */
export const RETURN_TO_HEADER = 'x-rekey-return-to';

/**
 * An access token minted this recently is not refreshed again when the API
 * refuses it. Without this a session the API rejects for a reason a refresh
 * does not cure would bounce between the page and the refresh route forever,
 * rotating on every lap.
 */
export const FRESH_TOKEN_WINDOW_SECONDS = 60;

/** Paths the middleware never sends through the refresh route. */
const EXEMPT_PREFIXES = [REFRESH_ROUTE, '/sign-out', '/login', '/api/'];

/** Path and query of `url`, without Next's `_rsc` cache-buster. */
export function returnPathOf(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete('_rsc');
  const search = params.toString();
  return `${url.pathname}${search ? `?${search}` : ''}`;
}

/**
 * Where the refresh route may send the browser afterwards: a same-origin path,
 * never the refresh route itself, `/` otherwise.
 */
export function refreshDestination(raw: unknown): string {
  const next = safeNext(raw);
  if (!next) return '/';
  if (next === REFRESH_ROUTE || next.startsWith(`${REFRESH_ROUTE}?`) || next.startsWith(`${REFRESH_ROUTE}/`)) {
    return '/';
  }
  return next;
}

/** The refresh route, carrying a validated return path. */
export function refreshRouteFor(returnTo: string | null | undefined): string {
  return `${REFRESH_ROUTE}?next=${encodeURIComponent(refreshDestination(returnTo))}`;
}

function jwtClaims(token: string): { iat?: unknown; exp?: unknown } | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as { iat?: unknown; exp?: unknown };
  } catch {
    return null;
  }
}

/**
 * True when `token` was issued in the last {@link FRESH_TOKEN_WINDOW_SECONDS}.
 * Read without verifying: it only chooses between two redirects, and a forged
 * `iat` can do no more than send its bearer to the sign-out route.
 */
export function wasIssuedRecently(token: string | null | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const iat = jwtClaims(token)?.iat;
  if (typeof iat !== 'number') return false;
  return now / 1000 - iat < FRESH_TOKEN_WINDOW_SECONDS;
}

/**
 * The middleware's check: a page request with a refresh cookie and no access
 * cookie is stale, not signed out. Returns the refresh URL to redirect to, or
 * null to let the request through.
 *
 * Only page loads (GET, HEAD). A Server Action is a POST and refreshes in
 * place, and redirecting its POST would lose the submission.
 *
 * And only document loads, never a script fetch: the RSC request behind a
 * client-side navigation or prefetch. Next removes both the `RSC` header and
 * the `_rsc` cache-buster before middleware sees the request, and does not put
 * `_rsc` back on a middleware redirect, so the chain would end in an RSC
 * payload served at the page's bare URL, which a CDN ignoring `Vary: RSC`
 * could cache for HTML visitors. `Sec-Fetch-Dest` is left alone, so it is what
 * tells the two apart. The fetch loses nothing by going through: every authed
 * page calls `api()`, which redirects from the render when the access token is
 * missing or refused.
 */
export function staleSessionRedirect(req: {
  method: string;
  url: URL;
  hasAccess: boolean;
  hasRefresh: boolean;
  /** The request's `Sec-Fetch-Dest`; absent (an older client) counts as a document. */
  fetchDest?: string | null;
}): string | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  if (req.fetchDest && req.fetchDest !== 'document') return null;
  if (req.hasAccess || !req.hasRefresh) return null;
  const path = req.url.pathname;
  if (EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`))) return null;
  return refreshRouteFor(returnPathOf(req.url));
}

/**
 * `REFRESH_TOKEN_RACED`: the API rotated this refresh token moments ago for
 * another request (a second tab, a second panel instance) and its replacement
 * is still unused. Nothing was revoked and nothing was issued. It is the one
 * refresh refusal that does not end the session: the winner's new pair is on
 * its way to (or already in) the browser, so the cookies are left alone and
 * the browser retries with what it holds now. Clearing them here would delete
 * the winner's fresh pair and sign the operator out.
 */
export const REFRESH_RACED_CODE = 'REFRESH_TOKEN_RACED';

/**
 * The loop guard for a raced refresh: a cookie holding a digest of the refresh
 * token that raced, so it only ever matches that one token.
 *
 * The first `RACED` for a token sets it and retries without touching the
 * session cookies. A second `RACED` for the SAME token means the browser still
 * holds the spent token after a full round trip: the winner's pair did not
 * reach it (a closed tab, a dropped response). That second one is treated like
 * any other refusal and the session cookies are cleared. Keeping the spent
 * token is not safe: presented again once the API's reuse window (15s by
 * default) has passed, it is `REFRESH_TOKEN_REUSED`, which revokes every
 * session the operator has on every device. And if the winner's pair does land
 * after the clear, its Set-Cookie simply restores the session.
 *
 * A digest rather than the token, so a refresh token is never written to a
 * second cookie.
 */
export const RACED_COOKIE = 'rekey_refresh_raced';
/** Outlasts the API's reuse window with margin; nothing needs it after that. */
export const RACED_MARK_MAX_AGE_SECONDS = 60;

/**
 * The sign-in `reason` for a session ended because its refresh token may have
 * been spent: the API failed or timed out mid-refresh, after it may already
 * have rotated. Not the operator's doing, and the sign-in page says so.
 */
export const SESSION_INTERRUPTED_REASON = 'session_interrupted';

/**
 * A 502, 503 or 504 with no Rekey error code in the body: a proxy answering
 * for an API that is not listening, which is every API redeploy. The refresh
 * never reached the API, so the token is unspent. A 5xx carrying a Rekey code
 * is the API itself, which may have rotated first.
 */
export function isGatewayFailure(status: number, body: unknown): boolean {
  if (status !== 502 && status !== 503 && status !== 504) return false;
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code !== 'string' || code === '';
}

/**
 * May this request rotate the refresh token?
 *
 * Only when the browser says it came from this origin (`same-origin`) or from
 * the operator (`none`: typed, bookmarked, reloaded). The refresh cookie is
 * SameSite=Lax, so a cross-site top-level navigation carries it: a page on
 * another site could open the refresh route and abort the navigation after the
 * API rotated, dropping the new cookies. The browser keeps the spent token,
 * and its next refresh is the replay that revokes every session the operator
 * has. No header at all is an older browser, or not a browser, and proceeds.
 * `same-site` is refused too: a sibling subdomain is not this origin.
 */
export function mayRotateFrom(headers: Headers): boolean {
  const site = headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A tiny page that asks for `sameOriginUrl` again, from this origin, and
 * touches no cookie. Answered to a cross-site request instead of rotating
 * (see {@link mayRotateFrom}). The meta refresh, and the link for a browser
 * that ignores it, is a navigation this origin starts, so it arrives as
 * `same-origin`. A redirect would not do: the browser keeps a chain's
 * cross-site marking across redirects, which is also why the middleware's hop
 * into the refresh route still arrives here as cross-site.
 *
 * No script. Framing is refused, and `Cross-Origin-Opener-Policy` cuts the
 * link to a cross-site opener, so the page that opened this one cannot
 * navigate it away mid-refresh. `sameOriginUrl` must already be a path on
 * this origin; it is escaped here, not validated.
 */
export function refreshInterstitial(sameOriginUrl: string): Response {
  const href = escapeHtml(sameOriginUrl);
  const body =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="robots" content="noindex">' +
    `<meta http-equiv="refresh" content="0;url=${href}">` +
    '<title>Continuing</title></head><body>' +
    `<p><a href="${href}">Continue</a></p>` +
    '</body></html>';
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/** The loop-guard value for `refreshToken`: a truncated SHA-256, hex. */
export async function racedMark(refreshToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refreshToken));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
