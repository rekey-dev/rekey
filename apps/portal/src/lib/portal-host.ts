/**
 * Which host a request reached the portal on, and whether it can be an
 * Application's custom domain.
 *
 * Pure and runtime-neutral: the middleware imports it too.
 */

/**
 * Set by the middleware on every request that reached a verified custom domain,
 * holding that domain. The middleware removes any copy the client sent, so a
 * render can trust it.
 */
export const PORTAL_HOST_HEADER = 'x-rekey-portal-host';

export const PROXY_SECRET_HEADER = 'x-rekey-proxy-secret';

/** Length-independent comparison, so the secret cannot be guessed a byte at a time. */
export function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * `raw` as a lower-case hostname without port or trailing dot, or null when it
 * is not one the API could ever verify: an IP address, a single label, or
 * anything with characters a DNS name cannot hold.
 */
export function domainName(raw: string | null | undefined): string | null {
  const host = (raw ?? '').trim().toLowerCase().replace(/:\d*$/, '').replace(/\.$/, '');
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  return host;
}

/**
 * The host the visitor asked for. `X-Forwarded-Host` is believed only on a
 * request carrying `X-Rekey-Proxy-Secret` equal to PORTAL_PROXY_SECRET, the
 * same proof `X-Forwarded-For` needs (lib/client-ip.ts): anything else could
 * have written it, and a CDN that keys its cache on `Host` would then store
 * one Application's pages under another's address. Otherwise `Host`.
 */
export function publicHost(headers: Headers, proxySecret: string | undefined): string | null {
  const secret = (proxySecret ?? '').trim();
  const presented = headers.get(PROXY_SECRET_HEADER);
  const forwarded = headers.get('x-forwarded-host')?.split(',')[0];
  if (secret && presented && sameSecret(presented, secret) && forwarded) return domainName(forwarded);
  return domainName(headers.get('host'));
}

/**
 * The origin of a custom domain. Always `https`: it is the only origin the API
 * allows for that Application, and the only one it accepts emailed links on.
 */
export function customDomainOrigin(domain: string): string {
  return `https://${domain}`;
}
