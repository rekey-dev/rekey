/**
 * Both passkey sign-in starts carry the auth tier's per-route cap (#416).
 * Each call is unauthenticated and mints a stored challenge, so without the
 * cap one address could create challenges as fast as it could send requests.
 *
 * Limits are neutered under NODE_ENV=test, so each case builds an app with
 * `REKEY_TEST_ENFORCE_RATE_LIMITS=1`, while fixtures come from an ordinary app.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const AUTH_START_CAP = 10;

let fixtures: FastifyInstance;

beforeAll(async () => {
  fixtures = await buildApp({ logger: false });
  await fixtures.ready();
});

afterAll(async () => {
  await fixtures.close();
});

async function enforcedApp(): Promise<FastifyInstance> {
  const prev = process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
  process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = '1';
  try {
    const app = await buildApp({ logger: false });
    await app.ready();
    return app;
  } finally {
    if (prev === undefined) delete process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
    else process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = prev;
  }
}

async function publishableKey(): Promise<string> {
  const slug = `pkstart-${Math.random().toString(36).slice(2, 9)}`;
  const operator = await fixtures
    .inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `${slug}@example.com`, password: 'pw-one-two-three', workspaceName: 'Passkey Co' },
    })
    .then((r) => (r.json().data as { accessToken: string }).accessToken);
  const application = await fixtures
    .inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: { authorization: `Bearer ${operator}` },
      payload: { name: 'Passkey', slug },
    })
    .then((r) => r.json().data as { id: string; publicKey: string });
  await prisma.application.update({
    where: { id: application.id },
    data: {
      authConfig: {
        methods: ['password', 'passkey'],
        passwordMinLength: 8,
        redirectUrls: [],
        organizationsEnabled: true,
        signupEnabled: true,
        passwordBreachCheckEnabled: false,
        mfa: 'optional',
        webauthn: { rpId: 'localhost', rpOrigins: ['http://localhost:3030'], rpName: 'T' },
      } as never,
    },
  });
  return application.publicKey;
}

async function statuses(app: FastifyInstance, request: InjectOptions, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await app.inject(request)).statusCode);
  return out;
}

describe('passkey authenticate/start rate limit', () => {
  it('end-user start: the request after the cap gets 429 RATE_LIMITED', async () => {
    const key = await publishableKey();
    const app = await enforcedApp();
    try {
      const request: InjectOptions = {
        method: 'POST',
        url: '/api/v1/auth/passkey/authenticate/start',
        remoteAddress: '203.0.113.71',
        headers: { authorization: `Bearer ${key}` },
        payload: {},
      };
      expect(await statuses(app, request, AUTH_START_CAP)).toEqual(Array(AUTH_START_CAP).fill(200));
      const over = await app.inject(request);
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe('RATE_LIMITED');

      const otherAddress = await app.inject({ ...request, remoteAddress: '203.0.113.72' });
      expect(otherAddress.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('end-user start: a new email on every request does not buy a new bucket', async () => {
    const key = await publishableKey();
    const app = await enforcedApp();
    try {
      const request = (i: number): InjectOptions => ({
        method: 'POST',
        url: '/api/v1/auth/passkey/authenticate/start',
        remoteAddress: '203.0.113.73',
        headers: { authorization: `Bearer ${key}` },
        payload: { email: `rotate-${i}@example.com` },
      });
      for (let i = 0; i < AUTH_START_CAP; i++) {
        expect((await app.inject(request(i))).statusCode).toBe(200);
      }
      const over = await app.inject(request(AUTH_START_CAP));
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await app.close();
    }
  });

  it('operator start: the request after the cap gets 429 RATE_LIMITED', async () => {
    process.env.PANEL_WEBAUTHN_RP_ID = 'panel.test';
    process.env.PANEL_WEBAUTHN_RP_ORIGINS = 'https://panel.test';
    const app = await enforcedApp();
    try {
      const request: InjectOptions = {
        method: 'POST',
        url: '/api/v1/tenant/auth/passkeys/authenticate/start',
        remoteAddress: '203.0.113.81',
      };
      expect(await statuses(app, request, AUTH_START_CAP)).toEqual(Array(AUTH_START_CAP).fill(200));
      const over = await app.inject(request);
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe('RATE_LIMITED');

      const otherAddress = await app.inject({ ...request, remoteAddress: '203.0.113.82' });
      expect(otherAddress.statusCode).toBe(200);
    } finally {
      await app.close();
      delete process.env.PANEL_WEBAUTHN_RP_ID;
      delete process.env.PANEL_WEBAUTHN_RP_ORIGINS;
    }
  });
});
