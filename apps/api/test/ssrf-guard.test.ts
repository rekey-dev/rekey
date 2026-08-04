/**
 * SSRF guard unit tests. Uses literal IPs so `dns.lookup` resolves without a
 * network round-trip (Node short-circuits IP literals).
 */

import { describe, expect, it } from 'vitest';
import { assertSafeUrl, assertSafeUrlResolved, isPrivateIp } from '../src/lib/ssrf-guard.js';

describe('isPrivateIp', () => {
  it('flags private / loopback / link-local / metadata ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1', // IPv4-mapped private
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('passes public addresses', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe('assertSafeUrl', () => {
  it('blocks the cloud metadata endpoint', async () => {
    await expect(
      assertSafeUrl('http://169.254.169.254/latest/meta-data/', { allowPrivate: false }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('blocks loopback by IP and by hostname', async () => {
    await expect(assertSafeUrl('http://127.0.0.1:8080', { allowPrivate: false })).rejects.toMatchObject(
      { code: 'SSRF_BLOCKED' },
    );
    await expect(assertSafeUrl('http://localhost/x', { allowPrivate: false })).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
    await expect(assertSafeUrl('http://[::1]/x', { allowPrivate: false })).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
  });

  it('blocks private IPv4 ranges', async () => {
    await expect(assertSafeUrl('https://10.1.2.3/hook', { allowPrivate: false })).rejects.toMatchObject(
      { code: 'SSRF_BLOCKED' },
    );
  });

  it('blocks non-http(s) schemes', async () => {
    await expect(assertSafeUrl('file:///etc/passwd', { allowPrivate: false })).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
  });

  it('allows a public IP literal', async () => {
    await expect(assertSafeUrl('https://93.184.216.34/cb', { allowPrivate: false })).resolves.toBeUndefined();
  });

  it('allowPrivate bypasses the check (self-host escape hatch)', async () => {
    await expect(assertSafeUrl('http://127.0.0.1:9000', { allowPrivate: true })).resolves.toBeUndefined();
  });
});

/**
 * Transition and translation prefixes that EMBED an IPv4 address.
 *
 * Each of these was a full bypass of `isPrivateIp`, because the guard compared
 * strings: `64:ff9b::7f00:1` does not *look* like loopback. `64:ff9b::/96` is
 * the RFC 6052 well-known NAT64 prefix and is standard on IPv6-only clusters,
 * so on such a deployment `64:ff9b::a9fe:a9fe` reached the cloud metadata
 * service through a guard that believed it was public.
 *
 * The public NAT64 case is here deliberately: over-blocking the whole prefix
 * would break legitimate IPv6-only deployments, so the check has to decode the
 * embedded address rather than reject on the prefix.
 */
describe('IPv6 addresses that embed an IPv4 address', () => {
  const blocked = [
    ['64:ff9b::7f00:1', 'NAT64 loopback'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 cloud metadata'],
    ['::7f00:1', 'IPv4-compatible loopback'],
    ['2002:7f00:1::', '6to4 loopback — the v4 is in the FIRST groups, not the tail'],
    ['fec0::1', 'deprecated site-local'],
  ] as const;

  for (const [ip, why] of blocked) {
    it(`blocks ${ip} (${why})`, () => {
      expect(isPrivateIp(ip)).toBe(true);
    });
  }

  it('still allows a public IPv4 reached through NAT64', () => {
    // 93.184.216.34 → 5db8:d822. Blocking the prefix wholesale would break
    // every IPv6-only deployment, so this is the case that keeps the fix honest.
    expect(isPrivateIp('64:ff9b::5db8:d822')).toBe(false);
  });

  it('still allows ordinary public addresses', () => {
    expect(isPrivateIp('93.184.216.34')).toBe(false);
    expect(isPrivateIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });
});

describe('reserved IPv4 ranges that are not RFC 1918', () => {
  // Never a legitimate webhook or SMTP destination, and routable enough to be
  // useful for probing. 192.0.0.0/24 holds the NAT64 discovery addresses.
  for (const ip of ['192.0.0.1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1']) {
    it(`blocks ${ip}`, () => expect(isPrivateIp(ip)).toBe(true));
  }
});

describe('assertSafeUrlResolved returns the addresses it approved', () => {
  // The addresses are the whole point of the function. Validating a hostname
  // and then handing the raw URL to `fetch` lets the runtime resolve again
  // independently — the DNS-rebinding TOCTOU. The caller pins the connection
  // to what came back here, so if this ever returns an empty array for a real
  // host, the pinning silently stops happening and nothing else notices.
  // The suite sets WEBHOOK_ALLOW_PRIVATE_TARGETS=true so fixtures can point at
  // localhost, and that flag short-circuits before resolution — so these cases
  // opt out explicitly, or they would assert nothing.
  it('returns at least one address for a public host', async () => {
    const addresses = await assertSafeUrlResolved('https://example.com/hook', {
      allowPrivate: false,
    });
    expect(addresses.length).toBeGreaterThan(0);
    for (const a of addresses) expect(isPrivateIp(a)).toBe(false);
  });

  it('still refuses a private target', async () => {
    await expect(
      assertSafeUrlResolved('http://127.0.0.1/hook', { allowPrivate: false }),
    ).rejects.toThrow();
  });

  it('returns an empty array when private targets are explicitly allowed', async () => {
    // The escape hatch short-circuits before resolution, so there is nothing
    // to pin — the caller must fall back to an unpinned fetch rather than
    // pinning to nothing.
    const addresses = await assertSafeUrlResolved('http://127.0.0.1/hook', { allowPrivate: true });
    expect(addresses).toEqual([]);
  });
});
