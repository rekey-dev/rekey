/**
 * Guards around the refresh route that are not about the token itself.
 *
 * Runtime-neutral (no `Buffer`, no `next/headers`), so the edge middleware and
 * the Node route handler can both import it.
 */

/**
 * May this request rotate the refresh token?
 *
 * Only when the browser says it came from this origin (`same-origin`) or from
 * the user (`none`: typed, bookmarked, reloaded). The refresh cookie is
 * SameSite=Lax, so a cross-site top-level navigation carries it: a page on
 * another site could open the refresh route and abort the navigation after the
 * API rotated, dropping the new cookies. The browser keeps the spent token,
 * and its next refresh is the replay that makes the API revoke every session
 * the user has. A request without the header is an older browser, or not a
 * browser at all, and proceeds as before.
 *
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
 * A tiny page that asks for `sameOriginUrl` again, from this origin.
 *
 * Answered instead of rotating to a cross-site request (see
 * {@link mayRotateFrom}). It touches no cookie. The meta refresh (and the link,
 * for a browser that ignores it) is a navigation this origin starts, so the
 * browser sends it as `Sec-Fetch-Site: same-origin` and the refresh runs then.
 * A redirect would not do: the browser keeps a chain's cross-site marking
 * across redirects, which is also why a middleware hop into the refresh route
 * still arrives here as cross-site.
 *
 * No script, so no CSP nonce to thread through. Framing is refused (the
 * cookie would not be sent in a cross-site frame anyway), and
 * `Cross-Origin-Opener-Policy` cuts the link to a cross-site opener, so the
 * page that opened this one cannot navigate it away mid-refresh.
 *
 * `sameOriginUrl` must already be a path on this origin; it is escaped here,
 * not validated.
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

/**
 * A 502, 503 or 504 that did not come from Rekey: no Rekey error envelope, so
 * `@rekey.dev/node` reports it as `UNKNOWN_ERROR`. That is a proxy in front of
 * the API answering for it, almost always because the API is restarting
 * (every deploy) and nothing is listening yet. The refresh never reached the
 * API, so the token is unspent.
 *
 * A 5xx WITH a Rekey code is the API itself answering, possibly after it
 * rotated, and is not this.
 */
export function isGatewayFailure(err: { code?: unknown; statusCode?: unknown }): boolean {
  const status = err.statusCode;
  if (status !== 502 && status !== 503 && status !== 504) return false;
  return typeof err.code !== 'string' || err.code === 'UNKNOWN_ERROR' || err.code === '';
}

/** Added to the sign-in URL when a refresh ended the session because the token may be spent. */
export const SESSION_INTERRUPTED_REASON = 'session_interrupted';
