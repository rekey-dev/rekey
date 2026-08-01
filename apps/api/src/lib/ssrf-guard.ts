/**
 * SSRF guard for outbound fetches to URLs influenced by tenants/end-users
 * (customer webhook endpoints, OIDC issuer + discovered endpoints).
 *
 * `isWebhookUrlSafe` in `webhook-signing.ts` does a *synchronous, string-level*
 * check — it blocks bare private IPs and obvious loopback hostnames but, by its
 * own admission, never resolves DNS. That leaves the real hole: a perfectly
 * public hostname whose A/AAAA record points at `169.254.169.254` (cloud
 * metadata), `10.x`, `::1`, etc. `assertSafeUrl` closes it by resolving the
 * host and rejecting if ANY resolved address is private/loopback/link-local.
 *
 * This is defence-in-depth, not a TOCTOU-proof sandbox: a determined attacker
 * can still rebind DNS between this lookup and the kernel's connect. Callers
 * should ALSO disable redirect-following (`redirect: 'manual' | 'error'`) so a
 * validated public host can't 3xx us onto an internal one. For hard guarantees,
 * front outbound traffic with an egress proxy. The `WEBHOOK_ALLOW_PRIVATE_TARGETS`
 * env flag is the documented escape hatch for self-hosters on private networks.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { env } from '../config/env.js';
import { RekeyError } from './error.js';

// IPv4 ranges that must never be reachable from a user-supplied URL:
// private (10/8, 172.16/12, 192.168/16), loopback (127/8), link-local +
// cloud-metadata (169.254/16), CGNAT (100.64/10), "this network" (0/8), and
// multicast/reserved (224-255). Tested with a trailing '.' so prefixes anchor.
const PRIVATE_IPV4_RE =
  /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|22[4-9]\.|2[3-5]\d\.)/;

export function isPrivateIpv4(ip: string): boolean {
  if (PRIVATE_IPV4_RE.test(ip + '.')) return true;
  // Reserved ranges that are not "private" in the RFC 1918 sense but are never
  // a legitimate webhook or SMTP destination, and are routable enough to be
  // useful to an attacker probing a network. 192.0.0.0/24 in particular holds
  // the NAT64 discovery addresses.
  return /^(192\.0\.0\.|198\.1[89]\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(ip);
}

export function isPrivateIpv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (
    h === '::1' || // loopback
    h === '::' || // unspecified
    h.startsWith('fc') || // unique-local fc00::/7
    h.startsWith('fd') ||
    h.startsWith('fe8') || // link-local fe80::/10
    h.startsWith('fe9') ||
    h.startsWith('fea') ||
    h.startsWith('feb') ||
    h.startsWith('fec') || // deprecated site-local fec0::/10
    h.startsWith('fed') ||
    h.startsWith('fee') ||
    h.startsWith('fef') ||
    h.startsWith('::ffff:') // IPv4-mapped — the v4 check runs first in isPrivateIp
  ) {
    return true;
  }

  // Transition and translation prefixes that EMBED an IPv4 address. Each of
  // these was a full bypass: the guard compared strings, so `64:ff9b::7f00:1`
  // did not look loopback even though it routes to 127.0.0.1 on any NAT64
  // deployment — and `64:ff9b::/96` is the RFC 6052 well-known prefix, which
  // is standard on IPv6-only Kubernetes clusters. `64:ff9b::a9fe:a9fe` would
  // have reached the cloud metadata service.
  const embedded = embeddedIpv4(h);
  return embedded !== null && isPrivateIpv4(embedded);
}

/**
 * The IPv4 address embedded in a translation/transition IPv6 address, or null.
 *
 * Covers NAT64 (`64:ff9b::/96` and `64:ff9b:1::/48`), IPv4-compatible
 * (`::a.b.c.d`, deprecated but still routed by some stacks) and 6to4
 * (`2002:V4ADDR::/16`). Accepts both the dotted-quad and hex-group spellings,
 * because `new URL` normalizes `[64:ff9b::127.0.0.1]` to `64:ff9b::7f00:1`.
 */
function embeddedIpv4(h: string): string | null {
  const quadFrom = (g1: string, g2: string): string => {
    const a = parseInt(g1, 16);
    const b = parseInt(g2, 16);
    if (Number.isNaN(a) || Number.isNaN(b)) return '';
    return `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
  };

  // 6to4 embeds the v4 in the FIRST two groups, so it must be checked before
  // anything that looks at the tail — `2002:7f00:1::` has no trailing groups
  // at all, which is exactly how it slipped through a tail-first version.
  if (h.startsWith('2002:')) {
    const m = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/);
    return m ? quadFrom(m[1]!, m[2]!) || null : null;
  }

  const isTranslation = h.startsWith('64:ff9b:') || /^::(?!ffff:)/.test(h);
  if (!isTranslation || h === '::' || h === '::1') return null;

  // Both spellings: `new URL` normalizes [64:ff9b::127.0.0.1] to 64:ff9b::7f00:1,
  // but the dotted form still arrives from callers that skip URL parsing.
  const dotted = h.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1]!;

  const tail = h.match(/([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  return tail ? quadFrom(tail[1]!, tail[2]!) || null : null;
}

export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) {
    const h = ip.toLowerCase();
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — validate the embedded v4.
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpv4(mapped[1]!);
    return isPrivateIpv6(h);
  }
  return false;
}

export interface SafeUrlOptions {
  /**
   * Permit private/loopback targets. Defaults to the
   * `WEBHOOK_ALLOW_PRIVATE_TARGETS` env flag — the escape hatch for
   * self-hosters whose webhook receivers / IdPs live on a private network.
   */
  allowPrivate?: boolean;
}

function blocked(reason: string): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'SSRF_BLOCKED',
    message: `Refusing to fetch this URL: ${reason}`,
    fix: 'Use a publicly-resolvable https(s) URL. Internal/loopback/link-local targets are blocked; set WEBHOOK_ALLOW_PRIVATE_TARGETS=true only if you intentionally run receivers on a private network.',
  });
}

/**
 * Resolve a URL's host and assert it is a public destination. Throws
 * `SSRF_BLOCKED` for a non-http(s) scheme, a loopback hostname, a DNS failure,
 * or any resolved address in a private/loopback/link-local range.
 */
/**
 * Reject a host:port pair that resolves anywhere non-public.
 *
 * Same DNS-level check as `assertSafeUrl`, minus the URL parsing — for
 * protocols that are not http(s) and therefore have no URL to parse. Today
 * that is operator-supplied SMTP, which was previously connected to with no
 * check at all: a workspace admin could point it at `127.0.0.1:6379` or
 * `169.254.169.254:80`, trigger a test send, and read the connection outcome
 * back out of the API response. That is an internal port scanner reachable
 * over the public API, and it existed because the guard lived next to the
 * webhook code rather than next to *outbound connections*.
 */
export async function assertSafeHost(host: string, options: SafeUrlOptions = {}): Promise<void> {
  const allowPrivate = options.allowPrivate ?? env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  if (allowPrivate) return;

  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!bare) throw blocked('host is empty.');
  if (bare === 'localhost' || bare.endsWith('.localhost')) {
    throw blocked('loopback hostnames are not allowed.');
  }

  let results: Array<{ address: string }>;
  try {
    results = await lookup(bare, { all: true });
  } catch {
    throw blocked(`DNS resolution failed for "${bare}".`);
  }
  if (results.length === 0) throw blocked(`"${bare}" did not resolve to any address.`);
  for (const r of results) {
    if (isPrivateIp(r.address)) {
      throw blocked(`"${bare}" resolves to a private/loopback address.`);
    }
  }
}

export async function assertSafeUrl(rawUrl: string, options: SafeUrlOptions = {}): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw blocked('URL is not parseable.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw blocked(`scheme "${parsed.protocol}" is not allowed; use http(s).`);
  }
  const allowPrivate = options.allowPrivate ?? env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  if (allowPrivate) return;

  const rawHost = parsed.hostname.toLowerCase();
  const host =
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw blocked('loopback hostnames are not allowed.');
  }

  // Resolve EVERY address the host maps to and reject if any is private — this
  // is the DNS-level check the synchronous filter can't do.
  let results: Array<{ address: string }>;
  try {
    results = await lookup(host, { all: true });
  } catch {
    throw blocked(`DNS resolution failed for "${host}".`);
  }
  if (results.length === 0) {
    throw blocked(`"${host}" did not resolve to any address.`);
  }
  for (const r of results) {
    if (isPrivateIp(r.address)) {
      // Deliberately NOT naming the resolved address. This message is stored
      // on the delivery row and served back to the tenant, so including it
      // turned the webhook log into an internal-DNS mapping oracle: point an
      // endpoint at an internal hostname, emit an event, read the private IP
      // out of the delivery error. The address stays in the server log.
      throw blocked(`"${host}" resolves to a private/loopback address.`);
    }
  }
}
