/**
 * IP allowlist matching for per-Application access control.
 *
 * Entries may be CIDRs ("10.0.0.0/8", "2001:db8::/32") or bare IPs ("1.2.3.4",
 * "::1"). v4 and v6 are handled independently; a malformed entry or a
 * version mismatch is skipped (never a false match). An empty list means
 * "allow all" — the caller gates on `.length > 0` before enforcing.
 */

import { Address4, Address6 } from 'ip-address';

/** Strip the IPv4-mapped-IPv6 prefix so a proxied `::ffff:1.2.3.4` matches v4 rules. */
function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) {
    const v4 = ip.slice('::ffff:'.length);
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) return v4;
  }
  return ip;
}

export function ipMatchesAllowlist(ip: string, allowlist: ReadonlyArray<string>): boolean {
  if (allowlist.length === 0) return true; // empty = allow all
  const addr = normalizeIp(ip);
  const addrIsV6 = addr.includes(':');
  for (const raw of allowlist) {
    const entry = raw.trim();
    if (!entry) continue;
    const entryIsV6 = entry.includes(':');
    if (entryIsV6 !== addrIsV6) continue; // can't match across families
    try {
      if (entryIsV6) {
        const subnet = new Address6(entry.includes('/') ? entry : `${entry}/128`);
        if (new Address6(addr).isInSubnet(subnet)) return true;
      } else {
        const subnet = new Address4(entry.includes('/') ? entry : `${entry}/32`);
        if (new Address4(addr).isInSubnet(subnet)) return true;
      }
    } catch {
      // malformed entry or unparseable address — treat as non-match
    }
  }
  return false;
}
