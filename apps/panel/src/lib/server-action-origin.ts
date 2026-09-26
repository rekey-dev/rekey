import { NextResponse } from 'next/server';

/**
 * Refuse a Server Action whose `Origin` header is present but not a URL.
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
 * sits in an opaque origin, a sandboxed iframe, a `data:` document, or a
 * form POST that followed a cross-origin redirect. That value is a string, so
 * the guard passes, `new URL('null')` throws `TypeError [ERR_INVALID_URL]`,
 * and nothing catches it. Every Server Action from such a client answers 500.
 * Reported against the panel's OAuth provider form; it was never specific to
 * that form, or to the panel.
 *
 * This used to delete the header, which was wrong. Lines 365-368 of the same
 * file treat an ABSENT origin as an old browser: Next warns and runs the
 * action with its origin-versus-host CSRF check skipped. Stripping turned a
 * crash into an unchecked action, for exactly the requests that deserve the
 * least trust: a same-site POST that crossed a cross-origin redirect still
 * carries `sameSite=lax` cookies. So the action is refused instead.
 *
 * The 403 is `text/plain` with no charset because Next's action client
 * (`server-action-reducer.js`, lines 98-111) rejects the action promise on any
 * non-RSC response and uses the body as the message only on exactly that
 * content type. The form leaves its pending state rather than sitting on
 * "Saving…".
 *
 * Only a POST carrying `Next-Action` is judged. Nothing else in Next parses
 * `Origin` unguarded, so other requests are left as the browser sent them. A
 * valid origin, same-site or not, is left for Next's own comparison.
 *
 * This mirrors `rejectMalformedActionOrigin` in `@rekey.dev/nextjs`; a change
 * to one must be made to the other.
 *
 * Returns the refusal, or `null` when the request should proceed unchanged.
 */
export function rejectMalformedActionOrigin(req: {
  method: string;
  headers: Headers;
}): NextResponse | null {
  if (req.method !== 'POST' || !req.headers.has('next-action')) return null;
  const origin = req.headers.get('origin');
  if (origin === null) return null;
  try {
    // eslint-disable-next-line no-new
    new URL(origin);
    return null;
  } catch {
    return new NextResponse(
      'Server Action refused: the request came from an opaque origin (Origin header is not a URL).',
      { status: 403, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } },
    );
  }
}
