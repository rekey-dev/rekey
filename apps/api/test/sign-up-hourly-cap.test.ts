/**
 * The hourly bucket on browser sign-ups.
 *
 * Where sign-up still answers 409 for a taken address, a browser key can ask
 * "does this address have an account". The per-minute bucket alone allows 600
 * such questions an hour from one address; the hourly one holds it to 30.
 *
 * Every limiter is neutered under NODE_ENV=test. This file opts back in with
 * REKEY_TEST_ENFORCE_RATE_LIMITS=1, the switch rate-limit-keying.test.ts uses.
 * The clock is moved between batches so the per-minute bucket is not what
 * refuses.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { SIGN_UP_HOURLY_MAX_PER_IP } from '../src/lib/rate-limit.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

const PROXY = '10.77.0.10';
const PER_MINUTE = 10;

describe('Hourly cap on browser sign-ups from one address', () => {
  operatorsConfirmTheirEmail();
  let app: FastifyInstance;
  let secretKey: string;
  let publishableKey: string;
  const previous = {
    enforce: process.env.REKEY_TEST_ENFORCE_RATE_LIMITS,
    trust: process.env.TRUSTED_PROXIES,
  };

  beforeAll(async () => {
    process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = '1';
    process.env.TRUSTED_PROXIES = PROXY;
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    if (previous.enforce === undefined) delete process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
    else process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = previous.enforce;
    if (previous.trust === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = previous.trust;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  let counter = 0;
  const signUp = (clientIp: string, key: string): Promise<LightMyRequestResponse> => {
    counter += 1;
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      remoteAddress: PROXY,
      headers: { authorization: `Bearer ${key}`, 'x-forwarded-for': clientIp },
      payload: { email: `hourly-${counter}@example.com`, password: 'pw-one-two-three' },
    });
  };

  it('the 31st sign-up from one address in an hour is refused; a secret key is not counted; another address is not affected', async () => {
    const slug = `hourly-${Math.random().toString(36).slice(2, 8)}`;
    const operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        remoteAddress: PROXY,
        headers: { 'x-forwarded-for': '198.51.100.200' },
        payload: { email: `op-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: slug },
      })
      .then((r) => ({ authorization: `Bearer ${(r.json().data as { accessToken: string }).accessToken}` }));
    const applicationId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: operator, payload: { name: slug, slug } })
      .then((r) => (r.json().data as { id: string }).id);
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: operator,
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    publishableKey = await prisma.application
      .findUniqueOrThrow({ where: { id: applicationId }, select: { publicKey: true } })
      .then((a) => a.publicKey);
    const quiet = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: operator,
      payload: { sendVerificationEmailOnSignUp: false, welcomeEmail: 'off' },
    });
    expect(quiet.statusCode, quiet.body).toBe(200);

    const browser = '203.0.113.50';
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    const statuses: number[] = [];
    for (let i = 0; i < SIGN_UP_HOURLY_MAX_PER_IP; i += 1) {
      // A new minute before each batch of ten, so the per-minute bucket is fresh.
      if (i > 0 && i % PER_MINUTE === 0) vi.setSystemTime(start + (i / PER_MINUTE) * 61_000);
      statuses.push((await signUp(browser, publishableKey)).statusCode);
    }
    expect(statuses, 'thirty sign-ups in the hour are served').toEqual(Array(SIGN_UP_HOURLY_MAX_PER_IP).fill(201));

    vi.setSystemTime(start + 4 * 61_000);
    const refused = await signUp(browser, publishableKey);
    expect(refused.statusCode, refused.body).toBe(429);
    expect(refused.json().error.code).toBe('RATE_LIMITED');
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter, 'the wait is what is left of the hour, not of a minute').toBeGreaterThan(60);
    expect(retryAfter).toBeLessThanOrEqual(3600);

    // A customer's own server creates users in bulk from one address.
    const bySecretKey = await signUp(browser, secretKey);
    expect(bySecretKey.statusCode, bySecretKey.body).toBe(201);
    // Somebody else's browser.
    const other = await signUp('203.0.113.51', publishableKey);
    expect(other.statusCode, other.body).toBe(201);
    // Still refused for the first address: neither of those spent or reset its bucket.
    expect((await signUp(browser, publishableKey)).statusCode).toBe(429);

    // Following the fix: once the hour has passed, the address is served again.
    vi.setSystemTime(start + 4 * 61_000 + (retryAfter + 1) * 1000);
    const later = await signUp(browser, publishableKey);
    expect(later.statusCode, later.body).toBe(201);
  }, 120_000);
});
