/**
 * The one validator for a caller-supplied `?next=` / `next` form field.
 *
 * There were four copies of this and every one of them was wrong the same way.
 * Each checked `startsWith('/') && !startsWith('//') && !startsWith('/\\') &&
 * !includes('://')`, which reads as airtight and is not: **browsers strip tab,
 * LF and CR out of a URL before they parse it.** So `/%09/evil.com` decodes to
 * `/\t/evil.com`, passes every one of those tests, and then resolves as
 * `https://evil.com/` once a browser has removed the tab. Measured:
 *
 *   new URL('/\t/evil.com', 'https://panel.rekey.dev').href
 *   // => 'https://evil.com/'
 *
 * On an operator console an open redirect is a phishing primitive: the victim
 * clicks a link on the real panel origin, is "signed in", and lands on a
 * copy of it. Login, sign-up, MFA verify and the OAuth callback all took this
 * parameter.
 *
 * Three protections, and they were checked individually rather than assumed.
 * Deleting any ONE of them leaves the tests green, because each covers the
 * others; deleting the first two together turns them red:
 *
 *   1. strip the C0 control range and DEL, so nothing a browser would remove
 *      later can change the meaning of what we validated. With this in place
 *      `/<TAB>/evil.com` collapses to `//evil.com` and the prefix test below
 *      is what rejects it;
 *   2. resolve against a placeholder origin and require the result to still be
 *      on it. This is what catches an escape spelled some way nobody
 *      predicted, including a future change in the URL parser;
 *   3. return `pathname + search + hash` rebuilt from the PARSED url, never
 *      the caller's string. This is the quiet one and the strongest: even with
 *      both checks above removed, `/<TAB>/evil.com` comes back as `/`, because
 *      the host half was never ours to return.
 *
 * Prefer keeping all three. They are three lines and they fail independently.
 *
 * Returns a same-origin path (with query and hash preserved), or null. Callers
 * treat null as "no destination was supplied" and fall back to their default.
 */
const PLACEHOLDER_ORIGIN = 'https://next.invalid';

export function safeNext(raw: unknown): string | null {
  const v = typeof raw === 'string' ? raw : String(raw ?? '');
  if (!v) return null;

  // eslint-disable-next-line no-control-regex
  const cleaned = v.replace(/[\u0000-\u001F\u007F]/g, '');
  if (!cleaned.startsWith('/') || cleaned.startsWith('//') || cleaned.startsWith('/\\')) {
    return null;
  }

  try {
    const url = new URL(cleaned, PLACEHOLDER_ORIGIN);
    if (url.origin !== PLACEHOLDER_ORIGIN) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
