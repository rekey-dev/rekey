/**
 * Refuse a Server Action whose `Origin` header is not a URL, before Next
 * crashes on it.
 *
 * Next 15's Server Action handler does this, unguarded
 * (`next/dist/server/app-render/action-handler.js`, next@15.5.18 line 355):
 *
 *     const originDomain =
 *       typeof req.headers['origin'] === 'string'
 *         ? new URL(req.headers['origin']).host
 *         : undefined;
 *
 * A browser sends the LITERAL STRING `"null"` as `Origin` whenever the page
 * sits in an opaque origin: a sandboxed iframe, a `data:` document, or a form
 * POST that followed a cross-origin redirect. That value is a string, so the
 * guard passes, `new URL('null')` throws `TypeError [ERR_INVALID_URL]`, and
 * nothing catches it. The action answers 500 before any of the app's code runs.
 *
 * Why refuse rather than strip the header. Lines 365-368 of the same file
 * treat an ABSENT origin as an old browser: Next logs a warning and runs the
 * action with its origin-versus-host CSRF check skipped. So deleting a
 * malformed origin does not restore a safe default, it turns a crash into an
 * unchecked action, and `Origin: null` comes from exactly the requests that
 * deserve the least trust. A same-site POST that crossed a cross-origin
 * redirect still carries `sameSite=lax` cookies, so the session cookie is no
 * defence there. Rewriting the header to the deployment's own origin would be
 * worse still: it asserts same-origin on a request that provably is not.
 *
 * A refusal is also what keeps the submit button honest. Next's action client
 * (`next/dist/client/components/router-reducer/reducers/server-action-reducer.js`,
 * lines 98-111) rejects the action promise on any response that is not
 * `text/x-component`, and uses the body as the error message when the status
 * is 400 or above and the content type is EXACTLY `text/plain`, with no
 * charset parameter. So the form leaves its pending state and the error
 * reaches the nearest error boundary, instead of the page waiting on a 500.
 *
 * Only a Server Action is refused: a POST carrying the `Next-Action` header.
 * Nothing else in Next parses `Origin` unguarded, so any other request with a
 * malformed origin is left exactly as the browser sent it. A form posted
 * before hydration (multipart, no `Next-Action` header) is not caught here,
 * because the middleware cannot tell a page from a route handler that accepts
 * uploads. Next still crashes on it with a 500, which fails closed: the
 * action does not run, and without JavaScript the browser shows the error
 * page rather than a stuck button.
 *
 * A valid origin is never judged here, same-site or not. Next compares it
 * with the host and rejects a cross-origin action itself, honouring
 * `serverActions.allowedOrigins`, and duplicating that would drift from it.
 */

import { NextResponse } from 'next/server';

/** The only parts of a `NextRequest` this reads, so it accepts a plain `Request` too. */
export interface ActionRequestLike {
  method: string;
  headers: Headers;
}

/** The body a refused action answers with, and the error message its caller sees. */
export const MALFORMED_ACTION_ORIGIN_MESSAGE =
  'Server Action refused: the request came from an opaque origin (Origin header is not a URL).';

function isUrl(value: string): boolean {
  try {
    // Not `URL.canParse`: older edge runtimes a Next 14 app may run on lack it.
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a 403 for a Server Action whose `Origin` is present but not a URL,
 * or `null` for every other request, which should proceed unchanged.
 *
 * For middleware you write yourself. `rekeyMiddleware` already applies it.
 *
 * ```ts
 * export function middleware(req: NextRequest) {
 *   return rejectMalformedActionOrigin(req) ?? NextResponse.next();
 * }
 * ```
 */
export function rejectMalformedActionOrigin(req: ActionRequestLike): NextResponse | null {
  if (req.method !== 'POST' || !req.headers.has('next-action')) return null;
  const origin = req.headers.get('origin');
  if (origin === null || isUrl(origin)) return null;
  return new NextResponse(MALFORMED_ACTION_ORIGIN_MESSAGE, {
    status: 403,
    // Exactly `text/plain`: Next's action client shows the body as the error
    // message only on that value, and a string body would otherwise default to
    // `text/plain;charset=UTF-8`.
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  });
}
