/**
 * Where a stale portal session is refreshed, and how a request gets there.
 *
 * The end-user refresh token is single-use and rotates on every exchange. The
 * API reads a replay of a rotated token as theft and revokes every session the
 * customer has, on every device (`revokeAllForEndUser`). So a refresh must only
 * happen where the new pair can be written back: a Server Action or a Route
 * Handler. A Server Component render cannot write cookies (Next 15 throws), so
 * a render that finds a dead access token redirects to
 * `/<slug>/session/refresh` instead, which rotates, writes the cookies and
 * sends the browser back.
 *
 * The session cookies are path-scoped to `/<slug>`, so the refresh route lives
 * under it (the browser would not send them anywhere else), and the return
 * path is held inside it too.
 *
 * Pure and runtime-neutral (no `Buffer`, no `next/headers`): the middleware
 * runs on the edge runtime and imports it too.
 */

import { isLocalPath, isPlainSlug } from './local-path';

/**
 * The path and query the browser asked for, stamped on every request by the
 * middleware (which overwrites any value the client sent), so a Server
 * Component can name its own URL in the refresh redirect.
 */
export const RETURN_TO_HEADER = 'x-rekey-return-to';

/**
 * An access token minted this recently is not refreshed again when the API
 * refuses it. Without this, a session the API rejects for a reason a refresh
 * does not cure would bounce between the page and the refresh route forever.
 */
export const FRESH_TOKEN_WINDOW_SECONDS = 60;

export function refreshRoutePath(slug: string): string {
  return `/${slug}/session/refresh`;
}

const PLACEHOLDER_ORIGIN = 'https://next.invalid';

/**
 * Where the refresh route may send the browser afterwards: a same-origin path
 * inside `/<slug>`, never the refresh route itself, `/<slug>` otherwise (and
 * `/` for a slug that is not one plain segment).
 *
 * Control characters and backslashes are refused (a browser strips the first
 * and reads the second as `/`), the input is resolved against a placeholder
 * origin and required to stay there, and the path rebuilt from the parsed URL
 * is itself checked with {@link isLocalPath}, because the parser collapses
 * dot-segments: `/..//evil.example` comes out as `//evil.example`. The
 * `/<slug>` prefix test happens to reject that shape today; the local-path
 * check is what keeps it rejected if the prefix rule ever loosens.
 */
export function refreshDestination(slug: string, raw: unknown): string {
  if (!isPlainSlug(slug)) return '/';
  const home = `/${slug}`;
  const v = typeof raw === 'string' ? raw : '';
  if (!isLocalPath(v)) return home;
  let url: URL;
  try {
    url = new URL(v, PLACEHOLDER_ORIGIN);
  } catch {
    return home;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return home;
  const path = url.pathname;
  if (path !== home && !path.startsWith(`${home}/`)) return home;
  const refresh = refreshRoutePath(slug);
  if (path === refresh || path.startsWith(`${refresh}/`)) return home;
  const rebuilt = `${path}${url.search}${url.hash}`;
  return isLocalPath(rebuilt) ? rebuilt : home;
}

/** The refresh route for `slug`, carrying a validated return path. */
export function refreshRouteFor(slug: string, returnTo: string | null | undefined): string {
  if (!isPlainSlug(slug)) return '/';
  return `${refreshRoutePath(slug)}?next=${encodeURIComponent(refreshDestination(slug, returnTo))}`;
}

/** Path and query of `url`, without Next's `_rsc` cache-buster. */
export function returnPathOf(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete('_rsc');
  const search = params.toString();
  return `${url.pathname}${search ? `?${search}` : ''}`;
}

/**
 * True when `token` was issued in the last {@link FRESH_TOKEN_WINDOW_SECONDS}.
 * Read without verifying: it only decides whether to try a refresh, and a
 * forged `iat` can do no more than make its bearer look signed out.
 */
export function wasIssuedRecently(token: string | null | undefined, now = Date.now()): boolean {
  if (!token) return false;
  try {
    const part = token.split('.')[1];
    if (!part) return false;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const { iat } = JSON.parse(new TextDecoder().decode(bytes)) as { iat?: unknown };
    return typeof iat === 'number' && now / 1000 - iat < FRESH_TOKEN_WINDOW_SECONDS;
  } catch {
    return false;
  }
}

/**
 * The middleware's check: a page request under `/<slug>` with a refresh cookie
 * and no access cookie is stale, not signed out. Returns the refresh URL to
 * redirect to, or null to let the request through.
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
 * tells the two apart. The fetch loses nothing by going through: the portal's
 * pages call `getPortalUser`, which redirects from the render when the access
 * token is missing or refused.
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
  const slug = req.url.pathname.split('/')[1];
  if (!slug || !isPlainSlug(slug)) return null;
  const refresh = refreshRoutePath(slug);
  if (req.url.pathname === refresh || req.url.pathname.startsWith(`${refresh}/`)) return null;
  return refreshRouteFor(slug, returnPathOf(req.url));
}

/**
 * `REFRESH_TOKEN_RACED`: the API rotated this refresh token moments ago for
 * another request (a second tab, a second portal instance) and its replacement
 * is still unused. Nothing was revoked and nothing was issued. It is the one
 * refresh refusal that does not end the session: the winner's new pair is on
 * its way to (or already in) the browser, so the cookies are left alone and
 * the browser retries with what it holds now. Clearing them here would delete
 * the winner's fresh pair and sign the customer out.
 */
export const REFRESH_RACED_CODE = 'REFRESH_TOKEN_RACED';

/**
 * The loop guard for a raced refresh: a cookie (path-scoped to `/<slug>`, like
 * the session) holding a digest of the refresh token that raced, so it only
 * ever matches that one token.
 *
 * The first `RACED` for a token sets it and retries without touching the
 * session cookies. A second `RACED` for the SAME token means the browser still
 * holds the spent token after a full round trip: the winner's pair did not
 * reach it (a closed tab, a dropped response). That second one is treated like
 * any other refusal and the session cookies are cleared. Keeping the spent
 * token is not safe: presented again once the API's reuse window (15s by
 * default) has passed, it is `REFRESH_TOKEN_REUSED`, which revokes every
 * session the customer has on every device. And if the winner's pair does land
 * after the clear, its Set-Cookie simply restores the session.
 *
 * A digest rather than the token, so a refresh token is never written to a
 * second cookie.
 */
export const RACED_COOKIE = 'rekey_portal_refresh_raced';
/** Outlasts the API's reuse window with margin; nothing needs it after that. */
export const RACED_MARK_MAX_AGE_SECONDS = 60;

/**
 * The sign-in `reason` for a session ended because its refresh token may have
 * been spent: the API failed or timed out mid-refresh, after it may already
 * have rotated. Not the customer's doing, and the sign-in page says so.
 */
export const SESSION_INTERRUPTED_REASON = 'session_interrupted';

/**
 * A 502, 503 or 504 with no Rekey error code: a proxy answering for an API
 * that is not listening, which is every API redeploy. The refresh never
 * reached the API, so the token is unspent. The browser SDK reports a body
 * without an envelope as `UNKNOWN_ERROR`. A 5xx carrying a Rekey code is the
 * API itself, which may have rotated first.
 */
export function isGatewayFailure(err: { statusCode?: unknown; code?: unknown }): boolean {
  const status = err.statusCode;
  if (status !== 502 && status !== 503 && status !== 504) return false;
  return typeof err.code !== 'string' || err.code === '' || err.code === 'UNKNOWN_ERROR';
}

/**
 * May this request rotate the refresh token?
 *
 * Only when the browser says it came from this origin (`same-origin`) or from
 * the customer (`none`: typed, bookmarked, reloaded). The refresh cookie is
 * SameSite=Lax, so a cross-site top-level navigation carries it: a page on
 * another site could open the refresh route and abort the navigation after the
 * API rotated, dropping the new cookies. The browser keeps the spent token,
 * and its next refresh is the replay that revokes every session the customer
 * has. No header at all is an older browser, or not a browser, and proceeds.
 * `same-site` is refused too: every app shares this portal host's parent.
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
 * A tiny page that asks for `sameOriginUrl` again from this origin, touching
 * no cookie. Answered to a cross-site request instead of rotating (see
 * {@link mayRotateFrom}). The meta refresh, and the link for a browser that
 * ignores it, is a navigation this origin starts, so it arrives as
 * `same-origin`. A redirect would not do: a redirect chain keeps its
 * cross-site marking, which is also why the middleware's hop into the refresh
 * route still arrives here as cross-site. No script; framing refused; and
 * `Cross-Origin-Opener-Policy` cuts the link to a cross-site opener.
 * `sameOriginUrl` must already be a path on this origin.
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
