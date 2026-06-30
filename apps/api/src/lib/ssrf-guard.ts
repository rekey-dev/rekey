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
import { RelipayError } from './error.js';

// IPv4 ranges that must never be reachable from a user-supplied URL:
// private (10/8, 172.16/12, 192.168/16), loopback (127/8), link-local +
// cloud-metadata (169.254/16), CGNAT (100.64/10), "this network" (0/8), and
// multicast/reserved (224-255). Tested with a trailing '.' so prefixes anchor.
const PRIVATE_IPV4_RE =
  /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|22[4-9]\.|2[3-5]\d\.)/;

export function isPrivateIpv4(ip: string): boolean {
  return PRIVATE_IPV4_RE.test(ip + '.');
}

export function isPrivateIpv6(ip: string): boolean {
  const h = ip.toLowerCase();
  return (
    h === '::1' || // loopback
    h === '::' || // unspecified
    h.startsWith('fc') || // unique-local fc00::/7
    h.startsWith('fd') ||
    h.startsWith('fe8') || // link-local fe80::/10
    h.startsWith('fe9') ||
    h.startsWith('fea') ||
    h.startsWith('feb') ||
    h.startsWith('::ffff:') // IPv4-mapped — defer to the v4 check below
  );
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

function blocked(reason: string): RelipayError {
  return new RelipayError({
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
      throw blocked(`"${host}" resolves to a private/loopback address (${r.address}).`);
    }
  }
}
