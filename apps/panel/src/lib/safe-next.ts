/**
 * The one validator for a caller-supplied `?next=` / `next` form field, and
 * for any other path the panel is about to put in a `Location` header.
 *
 * There were four copies of this and every one of them was wrong the same way.
 * Each checked `startsWith('/') && !startsWith('//') && !startsWith('/\\') &&
 * !includes('://')`, which reads as airtight and is not: **browsers strip tab,
 * LF and CR out of a URL before they parse it.** So `/%09/evil.com` decodes to
 * `/\t/evil.com`, passes every one of those tests, and then resolves as
 * `https://evil.com/` once a browser has removed the tab.
 *
 * The replacement had a second hole of the same shape. It checked the INPUT,
 * then returned `pathname + search + hash` rebuilt from `new URL(input)`. The
 * URL parser collapses dot-segments, so an input that passes every input test
 * comes back out as a protocol-relative URL:
 *
 *   new URL('/..//evil.com', 'https://next.invalid').pathname
 *   // => '//evil.com'
 *
 * and a browser given `Location: //evil.com` leaves the site. The same goes for
 * `/x/..//evil.com`, `/%2e%2e//evil.com` and `/./\evil.com` (the parser turns
 * `\` into `/`). On an operator console an open redirect is a phishing
 * primitive: the victim clicks a link on the real panel origin, is "signed
 * in", and lands on a copy of it.
 *
 * So the rule is: check what you return, not only what you were given.
 *
 *   1. refuse control characters and backslashes outright. A browser removes
 *      the first and reads the second as `/`, so either can change the meaning
 *      of a string after it was checked;
 *   2. resolve against a placeholder origin and require the result to still be
 *      on it;
 *   3. rebuild the path from the PARSED url, and then require THAT to be a
 *      local path ({@link isLocalPath}). This last check is the one that
 *      catches dot-segment collapse; nothing about the input predicts it.
 *
 * Returns a same-origin path (with query and hash preserved), or null. Callers
 * treat null as "no destination was supplied" and fall back to their default.
 */
const PLACEHOLDER_ORIGIN = 'https://next.invalid';

// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001F\u007F\\]/;

/**
 * True when `path` can only resolve to this origin: exactly one leading `/`,
 * not `//` or `/\` (both protocol-relative to a browser), and no character a
 * browser would strip or rewrite before parsing.
 */
export function isLocalPath(path: string): boolean {
  return path.startsWith('/') && path[1] !== '/' && !UNSAFE_CHARS.test(path);
}

export function safeNext(raw: unknown): string | null {
  const v = typeof raw === 'string' ? raw : String(raw ?? '');
  if (!v || !isLocalPath(v)) return null;

  let url: URL;
  try {
    url = new URL(v, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return null;
  const rebuilt = `${url.pathname}${url.search}${url.hash}`;
  return isLocalPath(rebuilt) ? rebuilt : null;
}
