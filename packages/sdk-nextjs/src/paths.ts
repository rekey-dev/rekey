/**
 * The two paths the middleware and the refresh route must agree on, and the
 * validator for the return path they pass between them.
 *
 * Dependency-free and runtime-neutral: the middleware imports it on the edge
 * and the refresh handler imports it on Node.
 */

/**
 * Where `rekeyMiddleware` sends a stale session, and where the README tells you
 * to put `rekeyRefreshHandler()`. One constant so the two cannot drift: a
 * middleware pointing at a route that does not exist is a 404 for every
 * signed-in visitor fifteen minutes after they sign in.
 */
export const DEFAULT_REFRESH_PATH = '/api/rekey/refresh';

/** Where both send a visitor who is signed out. */
export const DEFAULT_SIGN_IN_PATH = '/sign-in';

const PLACEHOLDER_ORIGIN = 'https://next.invalid';

/**
 * A caller-supplied return path, reduced to a same-origin path, or null.
 *
 * Refused outright rather than cleaned: anything with a control character (a
 * browser strips tab, CR and LF before parsing, so `/\t/evil.com` becomes
 * `//evil.com`), any backslash (browsers read `\` as `/`), anything not
 * starting with a single `/` (absolute URLs and `//host`). What survives is
 * resolved against a placeholder origin, must still be on it, and is rebuilt
 * from the PARSED url, so the host half of the input is never what we return.
 *
 * The rebuilt path is checked again, because parsing is not a no-op: WHATWG
 * URL collapses dot segments, so `/..//evil.com`, `/x/..//evil.com`,
 * `/%2e%2e//evil.com` and `/.//evil.com` all parse to the pathname
 * `//evil.com`, which every input check above passed and which a browser
 * reads as a protocol-relative URL to another host. So the output must not
 * start with `//` or `/\` either, whatever the input looked like.
 *
 * An encoded slash, backslash or control character in the path is refused
 * too. A browser leaves those encoded, so they are not an escape on their own,
 * but a proxy or a sign-in page that decodes `next` once before using it would
 * turn `/..%2f/evil.com` back into something that is.
 *
 * The layers overlap on purpose. Keep all of them.
 *
 * `excluded` paths are refused along with anything beneath them, so the
 * refresh route can never be told to send the browser back to itself.
 */
export function safeReturnPath(raw: string | null | undefined, excluded: readonly string[] = []): string | null {
  if (!raw) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(raw) || raw.includes('\\')) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;

  let url: URL;
  try {
    url = new URL(raw, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return null;
  const path = url.pathname;
  if (ENCODED_SEPARATOR_OR_CONTROL.test(path)) return null;
  if (excluded.some((p) => path === p || path.startsWith(`${p}/`))) return null;
  const rebuilt = `${path}${url.search}${url.hash}`;
  return isSingleSlashPath(rebuilt) ? rebuilt : null;
}

/** `%2F`, `%5C`, or an encoded C0 control or DEL, in either case. */
const ENCODED_SEPARATOR_OR_CONTROL = /%(?:2f|5c|[01][0-9a-f]|7f)/i;

/** Starts with exactly one `/`, not `//` or `/\` (which a browser reads as `//`). */
function isSingleSlashPath(value: string): boolean {
  return value.startsWith('/') && value[1] !== '/' && value[1] !== '\\';
}
