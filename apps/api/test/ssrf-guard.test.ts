/**
 * SSRF guard unit tests. Uses literal IPs so `dns.lookup` resolves without a
 * network round-trip (Node short-circuits IP literals).
 */

import { describe, expect, it } from 'vitest';
import { assertSafeUrl, isPrivateIp } from '../src/lib/ssrf-guard.js';

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
