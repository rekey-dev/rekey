import type { NextRequest } from 'next/server';

/**
 * Strip an `Origin` header that is present but not a URL.
 *
 * Next 15's Server Action handler does this, unguarded
 * (`next/dist/server/app-render/action-handler.js`):
 *
 *     const originDomain =
 *       typeof req.headers['origin'] === 'string'
 *         ? new URL(req.headers['origin']).host
 *         : undefined;
 *
 * A browser sends the LITERAL STRING `"null"` as `Origin` whenever the page
 * sits in an opaque origin — a sandboxed iframe, a `data:` document, or a
 * form POST that followed a cross-origin redirect. That value is a string, so
 * the guard passes, `new URL('null')` throws `TypeError [ERR_INVALID_URL]`,
 * and nothing catches it. Every Server Action from such a client answers 500.
 *
 * The visible symptom is worse than a failed save. `useFormStatus().pending`
 * never resolves, so the submit button sits on "Saving…" forever: the operator
 * is told the write is still in flight when it never started, and the only way
 * out is a reload. Reported against the panel's OAuth provider form; it was
 * never specific to that form, or to the panel.
 *
 * Deleting the header rather than repairing it is the deliberate choice.
 * Next's own next branch treats an ABSENT origin as an old browser, warns, and
 * proceeds — so removal restores exactly the behaviour Next already ships for
 * a request it cannot attribute. Rewriting the header to this deployment's own
 * origin would instead ASSERT same-origin on a request that is provably not,
 * which is the one thing the check exists to prevent. What actually defends
 * these routes is the session cookie's `sameSite`, which a genuine cross-site
 * POST does not carry.
 *
 * Returns the headers to forward, or `null` when nothing needs changing.
 */
export function sanitizedActionHeaders(req: NextRequest): Headers | null {
  const origin = req.headers.get('origin');
  if (origin === null) return null;
  try {
    // eslint-disable-next-line no-new
    new URL(origin);
    return null;
  } catch {
    const headers = new Headers(req.headers);
    headers.delete('origin');
    return headers;
  }
}
