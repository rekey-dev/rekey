import { env } from '../config/env.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * True when `raw` is an http(s) URL a person outside the cluster could use:
 * a dotted hostname, or loopback for local development. A single-label host
 * such as `http://api:3030` is a container name, which is unreachable for the
 * reader and discloses internal topology (#578).
 *
 * @example
 * isPublicHttpUrl('https://api.example.com'); // true
 * isPublicHttpUrl('http://api:3030');         // false
 */
export function isPublicHttpUrl(raw: string | undefined): raw is string {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS.has(url.hostname) || url.hostname.includes('.');
}

/**
 * The origin of this API as its callers reach it, for text a client reads:
 * error messages, `fix` sentences and the OpenAPI server list. Prefers
 * `PUBLIC_WEBHOOK_BASE_URL`, then `API_URL`, and returns null when neither is
 * a public URL, so the caller says "this deployment" instead of naming a host
 * nobody outside the cluster can call.
 *
 * @example
 * const origin = publicApiOrigin();
 * const where = origin ? `at ${origin}` : 'on this deployment';
 */
export function publicApiOrigin(): string | null {
  return firstPublicOrigin([env.PUBLIC_WEBHOOK_BASE_URL, env.API_URL]);
}

/**
 * The first candidate that is a public URL, without its trailing slash.
 *
 * @example
 * firstPublicOrigin([undefined, 'http://api:3030']); // null
 * firstPublicOrigin(['https://api.example.com/', 'http://api:3030']); // 'https://api.example.com'
 */
export function firstPublicOrigin(candidates: ReadonlyArray<string | undefined>): string | null {
  const candidate = candidates.find(isPublicHttpUrl);
  return candidate ? candidate.replace(/\/+$/, '') : null;
}
