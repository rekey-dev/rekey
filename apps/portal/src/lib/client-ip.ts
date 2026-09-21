/**
 * The visitor's address, for the portal's server-side calls to the API.
 *
 * Every page load fetches `GET /portal/config/:slug` from the portal's own
 * server, so without this every visitor of every Application arrived at the API
 * from the portal's one address and shared one per-IP budget. The API believes
 * the portal's forwarded address only when its own resolver
 * (apps/api/src/lib/client-ip.ts) can vouch for it: the portal's
 * INTERNAL_CALLER_SECRET, or its fixed address in TRUSTED_PROXIES. So what the
 * portal puts there picks a visitor's bucket.
 * It must be a value the portal can vouch for, which takes BOTH:
 *
 *   - PORTAL_TRUSTED_PROXY_HOPS=N (N proxies we run sit in front, each
 *     appending the address it saw; with Traefik alone N=1), and
 *   - the request carrying `X-Rekey-Proxy-Secret` equal to
 *     PORTAL_PROXY_SECRET. Traefik adds it on every request it forwards (a
 *     header middleware in docker-compose.prod.yml), overwriting any client
 *     copy, so a container on the same Docker network that reaches the portal
 *     around Traefik cannot produce it. A hop count alone would let exactly
 *     such a container choose the forwarded address.
 *
 * Then the client is the Nth entry from the right; everything left of it is
 * client-supplied and ignored. Otherwise nothing is forwarded, and the API sees
 * the portal itself, which it treats as a shared address and does not block.
 * Exactly one address is forwarded, and only a syntactically valid one. Same
 * rule as the panel (`apps/panel/src/lib/client-ip.ts`).
 */

import 'server-only';
import { isIP } from 'node:net';
import { headers } from 'next/headers';

export const PROXY_SECRET_HEADER = 'x-rekey-proxy-secret';

/** Length-independent comparison, so the secret cannot be guessed a byte at a time. */
function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function vouchedClientIp(
  forwardedFor: string | null | undefined,
  opts: {
    hops: string | undefined;
    secret: string | undefined;
    presentedSecret: string | null | undefined;
  },
): string | null {
  const hops = Number(opts.hops);
  if (!Number.isInteger(hops) || hops < 1) return null;
  const secret = (opts.secret ?? '').trim();
  if (!secret || !opts.presentedSecret || !sameSecret(opts.presentedSecret, secret)) return null;
  const parts = (forwardedFor ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < hops) return null;
  const candidate = parts[parts.length - hops]!;
  return isIP(candidate) === 0 ? null : candidate;
}

export const CALLER_SECRET_HEADER = 'x-rekey-caller-secret';
export const CLIENT_IP_HEADER = 'x-rekey-client-ip';

/**
 * Headers every server-side API call carries.
 *
 * `X-Rekey-Caller-Secret` (INTERNAL_CALLER_SECRET, when set) tells the API this
 * request comes from our portal whatever network path it took, and the API
 * then takes the visitor from `X-Rekey-Client-Ip` alone. That header is used
 * rather than X-Forwarded-For because the CDN and Traefik append to
 * X-Forwarded-For on the way to the public API origin, so on that path it
 * never holds just what the portal wrote. `X-Forwarded-For` is still sent for
 * the private-network path (docker-compose.prod.yml), where the API trusts
 * the portal by address. With no vouched visitor, neither is sent, and the
 * API treats the call as the portal's own shared address. Pure, for tests.
 */
export function apiCallHeaders(
  visitorIp: string | null,
  callerSecret: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const secret = (callerSecret ?? '').trim();
  if (secret) out[CALLER_SECRET_HEADER] = secret;
  if (visitorIp) {
    out[CLIENT_IP_HEADER] = visitorIp;
    out['x-forwarded-for'] = visitorIp;
  }
  return out;
}

/** Headers to add to a server-side API call: the caller secret and the vouched visitor IP. */
export async function forwardedClientHeaders(): Promise<Record<string, string>> {
  let ip: string | null = null;
  try {
    const h = await headers();
    ip = vouchedClientIp(h.get('x-forwarded-for'), {
      hops: process.env.PORTAL_TRUSTED_PROXY_HOPS,
      secret: process.env.PORTAL_PROXY_SECRET,
      presentedSecret: h.get(PROXY_SECRET_HEADER),
    });
  } catch {
    // Outside a request (build, tests): no visitor to forward.
  }
  return apiCallHeaders(ip, process.env.INTERNAL_CALLER_SECRET);
}

/** How long a server-side API call may take before the portal gives up. */
export const API_TIMEOUT_MS = 10_000;
