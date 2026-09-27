/**
 * Readers for operator-authored branding (`Application.portalBranding`).
 *
 * The JSON has no schema at rest and every value ends up in markup a buyer or
 * end user sees: an `<img src>`, an inline `style`, a `mailto:`. Each reader
 * returns a value that is safe to place there, or null. A malformed value
 * degrades to "no branding", never to an error.
 */

const EMAIL_RE = /^[^\s@{}<>"'()]+@[^\s@{}<>"'()]+\.[^\s@{}<>"'()]+$/;

/**
 * A CSS colour: hex, or rgb/rgba/hsl/hsla() with numbers only. Anything else,
 * `red;display:none` included, is null.
 *
 * @example
 * safeColor('#0d9488'); // '#0d9488'
 * safeColor('red;background:url(x)'); // null
 */
export function safeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/i.test(s)) return s;
  return null;
}

/**
 * An absolute URL whose scheme is https (or http when `httpsOnly` is false).
 * `javascript:` and `data:` are null.
 *
 * @example
 * safeUrl('https://cdn.example.com/logo.png', true); // 'https://cdn.example.com/logo.png'
 * safeUrl('javascript:alert(1)', false); // null
 */
export function safeUrl(value: unknown, httpsOnly: boolean): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:')) return url.href;
    return null;
  } catch {
    return null;
  }
}

/**
 * Trimmed text, cut to `max` characters, or null when empty.
 *
 * @example
 * safeText('  Acme  ', 80); // 'Acme'
 */
export function safeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s === '' ? null : s.slice(0, max);
}

/**
 * An email address plain enough to put in a `mailto:` link, or null.
 *
 * @example
 * safeEmail('help@acme.com'); // 'help@acme.com'
 * safeEmail('a@b.com?bcc=x'); // null
 */
export function safeEmail(value: unknown): string | null {
  const s = safeText(value, 254);
  return s !== null && EMAIL_RE.test(s) && !s.includes('?') ? s : null;
}
