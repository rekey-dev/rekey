/**
 * Validate that a server-side env value is safe to serialize into client HTML
 * as a copy-pasteable URL. Server-only vars like RELIPAY_URL / PANEL_URL may
 * point at in-cluster hosts (e.g. `http://api:3030`) that would both leak
 * internal topology and be unreachable for whoever pastes them.
 *
 * Accepts absolute http(s) URLs whose hostname is either dotted (a real
 * public-looking host) or `localhost`/loopback (local dev). Rejects
 * single-label in-cluster hostnames. Returns the URL without a trailing
 * slash, or null when the value should not be shown to the browser.
 */
export function publicHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname;
  const isLocalDev = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!isLocalDev && !host.includes('.')) return null;
  return raw.replace(/\/+$/, '');
}
