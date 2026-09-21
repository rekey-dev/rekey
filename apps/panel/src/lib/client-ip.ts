/**
 * The caller's IP, taken from the end of `X-Forwarded-For` rather than the
 * front.
 *
 * This read `xff.split(',')[0]`, which is the LEFTMOST entry, and that is the
 * one value in the header a client controls. Proxies APPEND, so for a request
 * that arrived as
 *
 *   X-Forwarded-For: 203.0.113.9
 *
 * with the attacker having sent that header themselves, our edge appends the
 * real address and the API receives
 *
 *   X-Forwarded-For: 203.0.113.9, <real client>
 *
 * Taking `[0]` hands back `203.0.113.9`, whatever the attacker typed. That is
 * then forwarded to the API as an `x-forwarded-for` we assert, one layer above
 * the API's own `TRUSTED_PROXIES` handling, so it lands in audit-log entries,
 * decides rate-limit buckets (rotate the value, get a fresh budget), and is
 * checked against `ADMIN_IP_ALLOWLIST`.
 *
 * The rightmost entry is the one our own edge wrote and is the only one not
 * forgeable from outside. It is what we forward.
 *
 * `X-Real-IP` stays as the fallback: it is a single value set by the proxy,
 * with no list for a client to prepend to.
 *
 * ## Which proxies to believe (`PANEL_TRUSTED_PROXIES`, `PANEL_PROXY_SECRET`)
 *
 * The panel cannot see its socket peer from a Server Component, only headers,
 * and Next fills `X-Forwarded-For` from the socket only when the header is
 * ABSENT (`??=` in `next/dist/server/base-server.js`); it never appends the
 * peer. So whatever reaches the panel directly with its own header would choose
 * the IP the API rate-limits operator sign-in and refresh on. `middleware.ts`
 * (via `forwardingHeaders` below) therefore decides, before anything renders:
 *
 *   - The header is believed only when `PANEL_TRUSTED_PROXIES` is at least 1
 *     AND the request carries `X-Rekey-Proxy-Secret` equal to
 *     `PANEL_PROXY_SECRET`. The proxy sets that header on every request it
 *     forwards (a Traefik `headers.customRequestHeaders` middleware, wired in
 *     the compose files), which also overwrites any value a client sent.
 *     Anything that reaches the panel without passing through that proxy, a
 *     browser on a published port or a sibling container on the same Docker
 *     network, cannot produce it.
 *   - Believed: the N-th entry from the right is the client (one Traefik is 1;
 *     Cloudflare in front of Traefik is 2), and the header is rewritten to
 *     that single address. A chain shorter than N is not believed.
 *   - Not believed: the header is deleted, Next fills the socket peer, and
 *     that is what is forwarded. No secret configured means never believed.
 *
 * The secret header and `X-Real-IP` never reach the app. Exactly one address
 * is forwarded to the API, never a list.
 *
 * A peer-address allowlist was the alternative, and was rejected: the panel
 * cannot read its peer where the decision has to be made, and on a Docker
 * network the proxy's address is not stable enough to allowlist anyway.
 */

/** `PANEL_TRUSTED_PROXIES` as a hop count. Anything unparseable is 0, the safe reading. */
export function trustedProxyHops(raw: string | undefined = process.env.PANEL_TRUSTED_PROXIES): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, 10);
}

/** The single address in an already-normalised `X-Forwarded-For`, or the rightmost entry. */
export function clientIpFrom(
  headerValue: string | null,
  realIp?: string | null,
  trustedHops: number = 1,
): string | null {
  const parts = (headerValue ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    const real = (realIp ?? '').trim();
    return real || null;
  }
  const fromRight = Math.max(1, trustedHops);
  // Fewer entries than trusted proxies: the request did not come through the
  // chain the deployment described, so no entry in it is vouched for.
  if (parts.length < fromRight) return null;
  return parts[parts.length - fromRight]!;
}

export const PROXY_SECRET_HEADER = 'x-rekey-proxy-secret';

/** Length-independent comparison, so the secret cannot be guessed a byte at a time. */
function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Set by `middleware.ts` on every request (any incoming copy is overwritten),
 * and read only server-side by `apiCallerHeaders`: whether the address left in
 * `X-Forwarded-For` is the visitor's.
 *
 *   - `peer`: no proxy is trusted, so the socket peer Next fills in IS the
 *     visitor.
 *   - `proxy`: the configured proxy proved itself and its chain was long
 *     enough; the header holds the visitor it reported.
 *   - `none`: a proxy is expected but did not prove itself, or its chain was
 *     too short. Next fills the socket peer, which is then the proxy or a
 *     neighbouring container, NOT the visitor.
 */
export const CLIENT_IP_SOURCE_HEADER = 'x-rekey-internal-client-ip-source';
export type ClientIpSource = 'peer' | 'proxy' | 'none';

/** The request headers `middleware.ts` passes on. See the module comment for the rules. */
export function forwardingHeaders(
  headers: Headers,
  opts: { hops: number; secret: string | undefined },
): Headers {
  const presented = headers.get(PROXY_SECRET_HEADER);
  const trusted =
    opts.hops > 0 && !!opts.secret && presented !== null && sameSecret(presented, opts.secret);
  const next = new Headers(headers);
  next.delete(PROXY_SECRET_HEADER);
  next.delete('x-real-ip');
  const xff = headers.get('x-forwarded-for');
  let source: ClientIpSource = opts.hops === 0 ? 'peer' : 'none';
  if (trusted && xff !== null) {
    const ip = clientIpFrom(xff, null, opts.hops);
    if (ip) {
      next.set('x-forwarded-for', ip);
      source = 'proxy';
    } else {
      next.delete('x-forwarded-for');
    }
  } else {
    next.delete('x-forwarded-for');
  }
  next.set(CLIENT_IP_SOURCE_HEADER, source);
  return next;
}

/**
 * The one misconfiguration that fails quietly: a hop count with no secret. The
 * panel then believes no `X-Forwarded-For` at all (correctly, since it cannot
 * tell the proxy from anything else) and reports the proxy's address for every
 * operator, so after the API keys sign-in and refresh limits on that address,
 * all operators share one budget. Logged once at startup by
 * `instrumentation.ts`; null when the configuration is coherent.
 */
export function proxyConfigWarning(env: {
  PANEL_TRUSTED_PROXIES?: string | undefined;
  PANEL_PROXY_SECRET?: string | undefined;
}): string | null {
  const hops = trustedProxyHops(env.PANEL_TRUSTED_PROXIES);
  if (hops === 0 || (env.PANEL_PROXY_SECRET ?? '').trim() !== '') return null;
  return (
    `[rekey-panel] PANEL_TRUSTED_PROXIES=${hops} but PANEL_PROXY_SECRET is not set, so X-Forwarded-For ` +
    'is never believed and every operator is reported to the API with the proxy\'s address (one shared ' +
    'sign-in and refresh rate limit). Set PANEL_PROXY_SECRET and have the proxy send it as the ' +
    'X-Rekey-Proxy-Secret request header; see DEPLOY.md "Upgrading: the panel\'s forwarded client IP".'
  );
}
