/**
 * Licence verify is throttled per (application, IP). The key holds no licence
 * key and no fingerprint, so a guesser cannot open a fresh bucket per guess,
 * and the limiter fails open on a store outage.
 */

import { expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { licenseRateLimit, licenseRateLimitKey } from '../src/lib/rate-limit.js';

it('throttles licence verify per (application, IP): a guesser cannot open a fresh bucket per key', () => {
  const req = (body: unknown, application: string | undefined, ip: string) =>
    ({ body, application: application ? { id: application } : undefined, ip }) as unknown as FastifyRequest;
  const a = licenseRateLimitKey(req({ key: 'rl_lic_secret', machineFingerprint: 'fp-1' }, 'app1', '203.0.113.9'));
  const guess = licenseRateLimitKey(req({ key: 'rl_lic_other', machineFingerprint: 'fp-2' }, 'app1', '203.0.113.9'));
  const otherApp = licenseRateLimitKey(req({ key: 'rl_lic_secret', machineFingerprint: 'fp-1' }, 'app2', '203.0.113.9'));
  const otherIp = licenseRateLimitKey(req({ key: 'rl_lic_secret', machineFingerprint: 'fp-1' }, 'app1', '198.51.100.7'));
  expect(guess).toBe(a);
  expect(new Set([a, otherApp, otherIp]).size).toBe(3);
  expect(a).toBe('license:app1:203.0.113.9');
  expect(a).not.toContain('rl_lic_secret');
  expect(a).not.toContain('fp-1');
  expect(licenseRateLimit(60).skipOnError).toBe(true);
});
