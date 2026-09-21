/**
 * Which client address to believe, and whether it can be used to block.
 *
 * Every per-IP guard (the anonymous budget, the rejected-credential block, the
 * per-IP ceiling across identities, sign-up and refresh caps) is only as good
 * as `request.ip`. There are four ways a request can arrive:
 *
 *   1. From one of OUR internal callers (the panel and portal), which prove it
 *      by sending `X-Rekey-Caller-Secret` equal to INTERNAL_CALLER_SECRET and
 *      the visitor address in `X-Rekey-Client-Ip`. This is the primary path:
 *      it works whatever network the call took, which is what the hosted units
 *      need, since they reach the API through its public origin. That one
 *      address is the client; a missing or malformed one is not vouched.
 *      X-Forwarded-For is never read here, the proxies in between append to it.
 *   2. From an internal caller on a private network instead, named by address
 *      in TRUSTED_PROXIES (the panel and portal on rekey-edge). They forward
 *      exactly one address they validated themselves, so that address is the
 *      client.
 *   3. Through OUR proxy (Traefik), which proves it by sending
 *      `X-Rekey-Proxy-Secret` equal to API_PROXY_SECRET on every request (a
 *      compose label; Traefik overwrites any client copy). The client is then
 *      the API_PROXY_HOPS-th entry from the right of X-Forwarded-For (1 for
 *      Traefik alone, 2 with Cloudflare in front, which only works if Traefik
 *      trusts Cloudflare's ranges).
 *   4. Anything else. X-Forwarded-For is discarded, so `request.ip` is the
 *      socket peer. Whether that peer is the CLIENT decides `vouched`:
 *        - no forwarding header at all: it is (a direct connection);
 *        - a forwarding header from a private, loopback or link-local peer
 *          means a proxy we cannot identify: Traefik with no secret
 *          configured, or with one configured but on a router that lost the
 *          secret middleware (an API domain re-added in Dokploy's UI). Its
 *          address is SHARED by everyone behind it, and blocking it would
 *          block them all, so it is not vouched, secret configured or not. A
 *          misconfiguration then turns per-IP blocking off instead of
 *          refusing everyone. `onUnprovenProxy` fires so it can be logged;
 *        - a public peer that sent the header itself is still the client.
 *
 * Unvouched traffic is never blocked by IP. It falls back to per-credential,
 * per-account and per-Application limits (see lib/rate-limit.ts), and buildApp
 * logs once at startup that per-IP protection behind an unidentified proxy is
 * off until API_PROXY_SECRET is set.
 *
 * A hop count in TRUSTED_PROXIES is still accepted for deployments that know
 * nothing else can reach the API, and believes that many hops from ANY peer.
 * No compose file uses one: on a shared Docker network it lets every other
 * container choose its address, including one on ADMIN_IP_ALLOWLIST.
 *
 * This runs inside Fastify's `rewriteUrl` (see app.ts), the one hook that sees
 * the raw request before Fastify builds its request object or logs it, and it
 * rewrites the raw headers there. Fastify (configured to trust exactly one hop)
 * then reports the one address left in X-Forwarded-For, or the socket peer when
 * there is none. The first root onRequest hook only copies the decision this
 * left behind onto `req.clientIpVouched`.
 */

import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export const PROXY_SECRET_HEADER = 'x-rekey-proxy-secret';
export const CALLER_SECRET_HEADER = 'x-rekey-caller-secret';
/** The visitor address our panel or portal vouches for, sent with the caller secret. */
export const CLIENT_IP_HEADER = 'x-rekey-client-ip';

/** Where the resolver leaves its decision on the raw request (see `rewriteUrl` in app.ts). */
export const CLIENT_IP_VOUCHED = Symbol('rekey.clientIpVouched');

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * True when `request.ip` is a client address safe to rate-limit and block
     * by; false when it is a proxy we cannot identify, shared by everyone
     * behind it. Set by the first onRequest hook in app.ts.
     */
    clientIpVouched: boolean;
  }
}

export interface ClientIpPolicy {
  /** Parsed TRUSTED_PROXIES: false, a hop count, or addresses/CIDRs/keywords. */
  internalCallers: false | number | string[];
  /** API_PROXY_SECRET, when set. */
  proxySecret?: string | undefined;
  /** API_PROXY_HOPS: entries from the right when the secret is presented. */
  proxyHops: number;
  /** INTERNAL_CALLER_SECRET: proves a request came from our panel or portal. */
  internalCallerSecret?: string | undefined;
  /**
   * Called when API_PROXY_SECRET is set but a private-network peer forwarded
   * without it: a proxy route missing the secret middleware. Rate-limit any
   * logging here; it can fire on every request.
   */
  onUnprovenProxy?: (peer: string) => void;
}

/** Private, loopback and link-local ranges: where an unidentified proxy would sit. */
const PRIVATE = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
  ] as const) {
    list.addSubnet(net, prefix, 'ipv4');
  }
  list.addSubnet('fc00::', 7, 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  list.addAddress('::1', 'ipv6');
  return list;
})();

const KEYWORDS: Record<string, Array<[string, number, 'ipv4' | 'ipv6']>> = {
  loopback: [
    ['127.0.0.0', 8, 'ipv4'],
    ['::1', 128, 'ipv6'],
  ],
  linklocal: [
    ['169.254.0.0', 16, 'ipv4'],
    ['fe80::', 10, 'ipv6'],
  ],
  uniquelocal: [
    ['10.0.0.0', 8, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['fc00::', 7, 'ipv6'],
  ],
};

/** `::ffff:10.0.0.1` → `10.0.0.1`, so IPv4 lists match dual-stack sockets. */
export function normalizeIp(ip: string | undefined | null): string {
  const value = (ip ?? '').trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  return mapped ? mapped[1]! : value;
}

function family(ip: string): 'ipv4' | 'ipv6' | null {
  const f = isIP(ip);
  return f === 4 ? 'ipv4' : f === 6 ? 'ipv6' : null;
}

function inList(list: BlockList, ip: string): boolean {
  const f = family(ip);
  return f !== null && list.check(ip, f);
}

function buildInternalList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const keyword = KEYWORDS[entry];
    if (keyword) {
      for (const [net, prefix, f] of keyword) list.addSubnet(net, prefix, f);
      continue;
    }
    const [addr, mask] = entry.split('/');
    const f = family(addr ?? '');
    if (!f) continue;
    if (mask === undefined) list.addAddress(addr!, f);
    else list.addSubnet(addr!, Number(mask), f);
  }
  return list;
}

/** Length-independent comparison. */
function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function headerValue(raw: IncomingMessage, name: string): string | undefined {
  const value = raw.headers[name];
  if (Array.isArray(value)) return value.join(',');
  return value;
}

/** The `hops`-th entry from the right, when it is a valid address. */
function fromRight(xff: string, hops: number): string | null {
  const parts = xff
    .split(',')
    .map((p) => normalizeIp(p))
    .filter(Boolean);
  if (parts.length < hops) return null;
  const candidate = parts[parts.length - hops]!;
  return isIP(candidate) === 0 ? null : candidate;
}

/**
 * Build the per-request resolver. It rewrites `raw.headers['x-forwarded-for']`
 * to at most one believed address, always removes the proxy-secret header, and
 * returns whether the resulting `request.ip` is a client address safe to block.
 */
export function createClientIpResolver(policy: ClientIpPolicy): (raw: IncomingMessage) => boolean {
  const internal = Array.isArray(policy.internalCallers)
    ? buildInternalList(policy.internalCallers)
    : null;
  const hopCount = typeof policy.internalCallers === 'number' ? policy.internalCallers : 0;
  const secret = policy.proxySecret && policy.proxySecret.length > 0 ? policy.proxySecret : null;
  const proxyHops = Math.max(1, policy.proxyHops);
  const callerSecret =
    policy.internalCallerSecret && policy.internalCallerSecret.length > 0
      ? policy.internalCallerSecret
      : null;

  return (raw) => {
    const peer = normalizeIp(raw.socket?.remoteAddress);
    const xff = headerValue(raw, 'x-forwarded-for');
    const presented = headerValue(raw, PROXY_SECRET_HEADER);
    const presentedCaller = headerValue(raw, CALLER_SECRET_HEADER);
    const callerClientIp = raw.headers[CLIENT_IP_HEADER];
    // Neither secret may reach a log line, a handler, or anything forwarded,
    // and the caller-vouched address means nothing without its secret.
    delete raw.headers[PROXY_SECRET_HEADER];
    delete raw.headers[CALLER_SECRET_HEADER];
    delete raw.headers[CLIENT_IP_HEADER];
    const viaOurProxy =
      secret !== null && presented !== undefined && sameSecret(presented, secret);
    // Forwarded host and scheme are believed only from our proxy. Nothing
    // reads them today; this keeps it that way for any caller that could forge
    // them.
    if (!viaOurProxy) {
      delete raw.headers['x-forwarded-host'];
      delete raw.headers['x-forwarded-proto'];
    }

    const believe = (ip: string | null): boolean => {
      if (ip) {
        raw.headers['x-forwarded-for'] = ip;
        return true;
      }
      delete raw.headers['x-forwarded-for'];
      return false;
    };

    // 0. Our panel or portal, proven by INTERNAL_CALLER_SECRET, whatever
    // network path it took (the hosted units call the public API origin, so
    // they arrive through the CDN and Traefik like anyone else). The visitor
    // address comes ONLY from X-Rekey-Client-Ip, one address the caller
    // validated. X-Forwarded-For is never read here: the CDN and Traefik
    // append to it even when the caller sent none, so its entries would be
    // the caller's own egress or the proxy, shared by every visitor. Missing
    // or malformed means the caller had no visitor address: not vouched.
    if (callerSecret && presentedCaller !== undefined && sameSecret(presentedCaller, callerSecret)) {
      const single = typeof callerClientIp === 'string' ? normalizeIp(callerClientIp) : '';
      return believe(single !== '' && isIP(single) !== 0 ? single : null);
    }

    // Legacy: a hop count believes the chain from any peer.
    if (hopCount > 0) {
      if (xff === undefined) return true;
      return believe(fromRight(xff, hopCount));
    }

    // 1. Our internal callers forward one validated address. One that
    // forwards nothing is reporting ITSELF, an address every visitor behind it
    // shares, so it is not one to block.
    if (internal && inList(internal, peer)) {
      if (xff === undefined) return false;
      return believe(fromRight(xff, 1));
    }

    // 2. Our proxy, proven by the shared secret.
    if (viaOurProxy) {
      if (xff === undefined) return true;
      // A chain shorter than configured did not come the way the deployment
      // described, so nothing in it is vouched for, and the peer is the proxy.
      return believe(fromRight(xff, proxyHops));
    }

    // 3. Anything else: the peer is what we have.
    delete raw.headers['x-forwarded-for'];
    if (xff === undefined) return true;
    if (!inList(PRIVATE, peer)) return true;
    if (secret) policy.onUnprovenProxy?.(peer);
    return false;
  };
}

/**
 * The one startup warning for the fallback mode. Null when the deployment has
 * said how its proxy identifies itself.
 */
export function proxySecretWarning(policy: ClientIpPolicy): string | null {
  if (policy.proxySecret) return null;
  if (typeof policy.internalCallers === 'number') return null;
  return (
    '[rate-limit] API_PROXY_SECRET is not set, so a request that reaches the API through a proxy ' +
    'on a private network (e.g. Traefik) cannot be traced to its client. Per-IP limits (the ' +
    'anonymous budget, the rejected-credential block, sign-up and refresh caps) are OFF for that ' +
    'traffic, which falls back to per-credential, per-account and per-Application limits. Set ' +
    'API_PROXY_SECRET and have the proxy send it as X-Rekey-Proxy-Secret; see docs/rate-limits.md.'
  );
}
