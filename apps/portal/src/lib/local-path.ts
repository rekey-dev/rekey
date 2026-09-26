/**
 * The last check before a path goes into a `Location` header.
 *
 * Checking a caller's input is not enough: the URL parser collapses
 * dot-segments and turns `\` into `/`, so `/..//evil.com` rebuilt from
 * `new URL(input).pathname` comes back as `//evil.com`, which a browser reads
 * as another host. Whatever is about to be returned is checked here, after
 * any normalisation.
 *
 * Pure and runtime-neutral: the middleware imports it too.
 */

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

/**
 * True when `slug` is a single path segment. Next decodes route params, so
 * `/%2Fevil.com/session/refresh` arrives with slug `/evil.com`, and
 * `` `/${slug}/login` `` would then be `//evil.com/login`.
 */
export function isPlainSlug(slug: string): boolean {
  return slug !== '' && slug !== '.' && slug !== '..' && !slug.includes('/') && isLocalPath(`/${slug}`);
}
