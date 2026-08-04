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

/**
 * Parse any textual IP to its bytes — 4 for v4, 16 for v6 — or null.
 *
 * Everything below range-checks these bytes. The previous implementation
 * compared STRINGS, and string comparison lost twice: first to the
 * translation prefixes that embed an IPv4 address (`64:ff9b::7f00:1` does not
 * look like loopback), and then, after that was patched, to the uncompressed
 * spelling of the very same address — `0:0:0:0:0:ffff:127.0.0.1` sailed past a
 * check that only recognised `::ffff:127.0.0.1`.
 *
 * That second miss was reachable: `assertSafeHost` takes a raw host string and
 * `dns.lookup` returns a literal IP verbatim, so nothing normalised it on the
 * way in, and an operator could open a real SMTP session to loopback. Bytes
 * have no spellings.
 */
function ipToBytes(ip: string): Uint8Array | null {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    return Uint8Array.from(parts);
  }
  if (version !== 6) return null;

  let text = ip.toLowerCase();
  // A trailing dotted quad (::ffff:127.0.0.1) — rewrite it to two hex groups.
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const quad = dotted[2]!.split('.').map(Number);
    if (quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((quad[0]! << 8) | quad[1]!).toString(16);
    const lo = ((quad[2]! << 8) | quad[3]!).toString(16);
    text = `${dotted[1]}${hi}:${lo}`;
  }

  const [head, tail] = text.split('::') as [string, string | undefined];
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  const fill = 8 - headGroups.length - tailGroups.length;
  if (tail === undefined && headGroups.length !== 8) return null;
  if (tail !== undefined && fill < 0) return null;

  const groups =
    tail === undefined
      ? headGroups
      : [...headGroups, ...Array<string>(fill).fill('0'), ...tailGroups];

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const value = parseInt(groups[i]!, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) return null;
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/** Reserved / non-routable IPv4, checked numerically. */
function isPrivateV4Bytes(b: Uint8Array): boolean {
  const [a, second] = [b[0]!, b[1]!];
  if (a === 0 || a === 10 || a === 127) return true;                 // this-network, RFC1918, loopback
  if (a === 172 && second >= 16 && second <= 31) return true;        // RFC1918
  if (a === 192 && second === 168) return true;                      // RFC1918
  if (a === 169 && second === 254) return true;                      // link-local, incl. cloud metadata
  if (a === 100 && second >= 64 && second <= 127) return true;       // CGNAT
  if (a >= 224) return true;                                         // multicast + reserved + broadcast
  // Ranges that are not "private" but are never a legitimate destination.
  if (a === 192 && second === 0 && b[2] === 0) return true;          // 192.0.0.0/24 (incl. NAT64 discovery)
  if (a === 192 && second === 0 && b[2] === 2) return true;          // TEST-NET-1
  if (a === 198 && (second === 18 || second === 19)) return true;    // benchmarking
  if (a === 198 && second === 51 && b[2] === 100) return true;       // TEST-NET-2
  if (a === 203 && second === 0 && b[2] === 113) return true;        // TEST-NET-3
  return false;
}

export function isPrivateIpv4(ip: string): boolean {
  const b = ipToBytes(ip);
  return b !== null && b.length === 4 && isPrivateV4Bytes(b);
}

export function isPrivateIpv6(ip: string): boolean {
  const b = ipToBytes(ip);
  return b !== null && b.length === 16 && isPrivateV6Bytes(b);
}

function isPrivateV6Bytes(b: Uint8Array): boolean {
  const allZeroThrough = (n: number): boolean => b.slice(0, n).every((x) => x === 0);
  // Local aliases so `noUncheckedIndexedAccess` doesn't force a `!` on every byte.
  const b0 = b[0] ?? 0;
  const b1 = b[1] ?? 0;

  // ::1 loopback and :: unspecified
  if (allZeroThrough(15) && (b[15] === 1 || b[15] === 0)) return true;
  if (b0 === 0xff) return true;                                  // multicast ff00::/8
  if ((b0 & 0xfe) === 0xfc) return true;                         // unique-local fc00::/7
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true;        // link-local fe80::/10
  if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return true;        // deprecated site-local fec0::/10

  // Forms that EMBED an IPv4 address — decode and judge the embedded address,
  // rather than blocking the prefix, so legitimate public v4 reached this way
  // keeps working.
  const embedded = (o: number): Uint8Array => b.slice(o, o + 4);
  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96
  if (allZeroThrough(10) && b[10] === 0xff && b[11] === 0xff) return isPrivateV4Bytes(embedded(12));
  if (allZeroThrough(12)) return isPrivateV4Bytes(embedded(12));
  // NAT64 64:ff9b::/96 (RFC 6052 well-known prefix)
  if (b0 === 0x00 && b1 === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return isPrivateV4Bytes(embedded(12));
  }
  // 6to4 2002::/16 — the v4 lives in bytes 2..5
  if (b0 === 0x20 && b1 === 0x02) return isPrivateV4Bytes(embedded(2));
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const b = ipToBytes(ip);
  if (b === null) return false;
  return b.length === 4 ? isPrivateV4Bytes(b) : isPrivateV6Bytes(b);
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

/**
 * Validate a URL and return the addresses it resolved to.
 *
 * The addresses are the point. Checking a hostname and then handing the raw
 * URL to `fetch` lets the runtime re-resolve independently, so a record with a
 * short TTL that alternates public and private wins the race — the classic
 * DNS-rebinding TOCTOU. The caller is expected to pin the connection to one of
 * these, which `webhook.service.ts` does via an undici dispatcher.
 *
 * Exploitability here was above average: each event allows up to 5 delivery
 * attempts, each resolving again, and a tenant can emit unlimited events by
 * hitting their own application's signup endpoint.
 */
export async function assertSafeUrlResolved(
  rawUrl: string,
  options: SafeUrlOptions = {},
): Promise<string[]> {
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
  if (allowPrivate) return [];

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
  return results.map((r) => r.address);
}

/** Back-compat wrapper for callers that do not pin the connection. */
export async function assertSafeUrl(
  rawUrl: string,
  options: SafeUrlOptions = {},
): Promise<void> {
  await assertSafeUrlResolved(rawUrl, options);
}
