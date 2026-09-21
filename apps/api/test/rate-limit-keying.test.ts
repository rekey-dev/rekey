/**
 * Who the rate limiters count a request against, driven on the wire through
 * the real `buildApp()` wiring.
 *
 * The bug: the global limiter keyed on `req.apiKey?.id ?? req.ip`. Operator
 * panel requests carry a JWT, not an API key, and in Docker every one of them
 * arrives from the panel container, so every operator on a deployment shared
 * one 100-per-minute bucket. One operator browsing hit 429 within a few pages.
 * The operator sign-in ceiling had the same shape: no Application, so it keyed
 * on the panel's IP, and anyone spraying the login page could lock every
 * operator out.
 *
 * Every limiter is neutered under NODE_ENV=test (lib/rate-limit.ts). These
 * tests build a SECOND app with `REKEY_TEST_ENFORCE_RATE_LIMITS=1`, so the real
 * caps and keying apply there, while fixtures are created through an ordinary
 * app so setup traffic spends nobody's budget. Each app has its own in-memory
 * store (getRedis() is null in test), so buckets never leak between tests that
 * build their own enforced app.
 *
 * Budgets are the env defaults: 100 anonymous per IP, 600 per operator or end
 * user, 6000 per secret key, 60 refreshes per IP, auth routes 10.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const PANEL_IP = '10.77.0.10';
const PANEL_TRUST = PANEL_IP;

interface Operator {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

let fixtures: FastifyInstance;

beforeAll(async () => {
  fixtures = await buildApp({ logger: false });
  await fixtures.ready();
});

afterAll(async () => {
  await fixtures.close();
});

/**
 * Build an app with the real caps on. `trustedProxies` sets TRUSTED_PROXIES for
 * this build only; it is read once, in buildApp.
 */
async function enforcedApp(trustedProxies?: string): Promise<FastifyInstance> {
  const prevEnforce = process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
  const prevTrust = process.env.TRUSTED_PROXIES;
  process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = '1';
  if (trustedProxies === undefined) delete process.env.TRUSTED_PROXIES;
  else process.env.TRUSTED_PROXIES = trustedProxies;
  try {
    const app = await buildApp({ logger: false });
    await app.ready();
    return app;
  } finally {
    if (prevEnforce === undefined) delete process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
    else process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = prevEnforce;
    if (prevTrust === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = prevTrust;
  }
}

async function makeOperator(tag: string): Promise<Operator> {
  const res = await fixtures.inject({
    method: 'POST',
    url: '/api/v1/tenant/auth/sign-up',
    payload: { email: `rl-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${tag}` },
  });
  expect(res.statusCode).toBe(201);
  const data = res.json().data as { accessToken: string; refreshToken: string; user: { id: string } };
  return { accessToken: data.accessToken, refreshToken: data.refreshToken, userId: data.user.id };
}

/**
 * Fire `n` identical requests in concurrent batches; return every status code.
 * For the 600-request operator budget, where a sequential loop over an
 * authenticated route outruns the test timeout.
 */
async function burn(
  app: FastifyInstance,
  n: number,
  req: InjectOptions,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let done = 0; done < n; done += 10) {
    const batch = Array.from({ length: Math.min(10, n - done) }, () => app.inject(req));
    for (const r of await Promise.all(batch)) statuses.push(r.statusCode);
  }
  return statuses;
}

/** Fire `n` identical requests; return the last response. */
async function fire(
  app: FastifyInstance,
  n: number,
  req: InjectOptions,
): Promise<LightMyRequestResponse> {
  let last: LightMyRequestResponse | undefined;
  for (let i = 0; i < n; i++) last = await app.inject(req);
  return last!;
}

function me(op: Operator, remoteAddress = PANEL_IP) {
  return {
    method: 'GET' as const,
    url: '/api/v1/tenant/auth/me',
    remoteAddress,
    headers: { authorization: `Bearer ${op.accessToken}` },
  };
}

function anon(remoteAddress: string, headers: Record<string, string> = {}) {
  return { method: 'GET' as const, url: '/api/v1/tenant/auth/signup-mode', remoteAddress, headers };
}

describe('global limiter keys on the caller, not the panel IP', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await enforcedApp();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('two operators behind the same source IP get independent buckets', async () => {
    const a = await makeOperator('a');
    const b = await makeOperator('b');

    const first = await app.inject(me(a));
    expect(first.statusCode).toBe(200);
    // The operator budget, not the anonymous one: the key generator saw
    // req.tenantUser, which proves requireTenantSession (an instance onRequest
    // hook) ran BEFORE the limiter's hook.
    expect(first.headers['x-ratelimit-limit']).toBe('600');

    const statuses = await burn(app, 599, me(a));
    expect(statuses.every((code) => code === 200)).toBe(true);
    const over = await app.inject(me(a));
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');

    // Operator B, same source address, untouched.
    const other = await app.inject(me(b));
    expect(other.statusCode).toBe(200);
    expect(other.headers['x-ratelimit-remaining']).toBe('599');

    // And the anonymous per-IP bucket for that address was never spent.
    const unauth = await app.inject(anon(PANEL_IP));
    expect(unauth.statusCode).toBe(200);
    expect(unauth.headers['x-ratelimit-limit']).toBe('100');
    expect(unauth.headers['x-ratelimit-remaining']).toBe('99');
  }, 180_000);

  it('an operator PAT counts against the same operator, not the IP', async () => {
    const a = await makeOperator('pat');
    const mint = await fixtures.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { name: 'agent', scopes: ['read'] },
    });
    expect(mint.statusCode).toBe(201);
    const pat = (mint.json().data as { rawToken: string }).rawToken;

    // Spend the address's anonymous budget entirely.
    expect((await fire(app, 101, anon(PANEL_IP))).statusCode).toBe(429);

    const viaPat = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/operator/applications',
      remoteAddress: PANEL_IP,
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(viaPat.statusCode).toBe(200);
    expect(viaPat.headers['x-ratelimit-limit']).toBe('600');
    expect(viaPat.headers['x-ratelimit-remaining']).toBe('599');

    // Same person on a session JWT: one bucket per operator, whichever credential.
    const viaJwt = await app.inject(me(a));
    expect(viaJwt.headers['x-ratelimit-remaining']).toBe('598');
  });

  it('unauthenticated traffic is still limited at 100 per IP', async () => {
    const hundredth = await fire(app, 100, anon('198.51.100.7'));
    expect(hundredth.statusCode).toBe(200);
    const over = await app.inject(anon('198.51.100.7'));
    expect(over.statusCode).toBe(429);
    expect(over.headers['x-ratelimit-limit']).toBe('100');
    // A different address is a different bucket.
    expect((await app.inject(anon('198.51.100.8'))).statusCode).toBe(200);
  });

  describe('API keys and end users', () => {
    let secretKey: string;
    let publicKey: string;

    beforeEach(async () => {
      const tenant = await fixtures
        .inject({
          method: 'POST',
          url: '/api/v1/admin/tenants',
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { name: 'T', ownerEmail: 'rl-owner@example.com' },
        })
        .then((r) => r.json().data as { id: string });
      const application = await fixtures
        .inject({
          method: 'POST',
          url: '/api/v1/admin/applications',
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { tenantId: tenant.id, name: 'A', slug: 'rl-app' },
        })
        .then((r) => r.json().data as { id: string; publicKey: string });
      const key = await fixtures
        .inject({
          method: 'POST',
          url: `/api/v1/admin/applications/${application.id}/api-keys`,
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { name: 'backend', mode: 'live' },
        })
        .then((r) => r.json().data as { rawKey: string });
      secretKey = key.rawKey;
      publicKey = application.publicKey;
    });

    it('a secret API key gets its own, larger budget', async () => {
      const ip = '203.0.113.20';
      expect((await fire(app, 101, anon(ip))).statusCode).toBe(429);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me/',
        remoteAddress: ip,
        headers: { authorization: `Bearer ${secretKey}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('6000');
      expect(res.headers['x-ratelimit-remaining']).toBe('5999');
    });

    it('a signed-in end user is keyed on the user, not the IP', async () => {
      const signUp = await fixtures.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${publicKey}` },
        payload: { email: 'rl-user@example.com', password: 'correct-horse-battery' },
      });
      expect(signUp.statusCode).toBe(201);
      const token = (signUp.json().data as { accessToken: string }).accessToken;

      const ip = '203.0.113.21';
      expect((await fire(app, 101, anon(ip))).statusCode).toBe(429);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/',
        remoteAddress: ip,
        headers: { authorization: `Bearer ${publicKey}`, 'x-rekey-user-token': token },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('600');
      expect(res.headers['x-ratelimit-remaining']).toBe('599');
    });
  });
});

describe('client IP behind the panel', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await enforcedApp(PANEL_TRUST);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('a spoofed X-Forwarded-For from an untrusted peer is ignored', async () => {
    // Direct caller, not the panel: rotating the header must not mint buckets.
    for (let i = 0; i < 100; i++) {
      const r = await app.inject(anon('203.0.113.66', { 'x-forwarded-for': `192.0.2.${i}` }));
      expect(r.statusCode).toBe(200);
    }
    const over = await app.inject(anon('203.0.113.66', { 'x-forwarded-for': '192.0.2.250' }));
    expect(over.statusCode).toBe(429);
  });

  it('the panel forwards a real client IP, and only the rightmost entry counts', async () => {
    const viaPanel = (xff: string) => anon(PANEL_IP, { 'x-forwarded-for': xff });
    expect((await fire(app, 100, viaPanel('198.51.100.1'))).statusCode).toBe(200);
    expect((await app.inject(viaPanel('198.51.100.1'))).statusCode).toBe(429);
    // A client who prepends its own entry is still keyed on the rightmost one.
    expect((await app.inject(viaPanel('192.0.2.9, 198.51.100.1'))).statusCode).toBe(429);
    // A different real client through the same panel is a different bucket.
    expect((await app.inject(viaPanel('198.51.100.2'))).statusCode).toBe(200);
  });

  it('operator sign-in ceiling keys on the real client, so one sprayer cannot lock everyone out', async () => {
    const forgot = (client: string, email: string) => ({
      method: 'POST' as const,
      url: '/api/v1/tenant/auth/forgot-password',
      remoteAddress: PANEL_IP,
      headers: { 'x-forwarded-for': client },
      payload: { email },
    });
    // Distinct emails, so the per-identity cap never trips: this is the
    // ceiling (RATE_LIMIT_MAX per client IP across every auth route).
    for (let i = 0; i < 100; i++) {
      const r = await app.inject(forgot('198.51.100.66', `spray-${i}@example.com`));
      expect(r.statusCode).toBe(200);
    }
    const blocked = await app.inject(forgot('198.51.100.66', 'spray-x@example.com'));
    expect(blocked.statusCode).toBe(429);
    // A real operator elsewhere, arriving through the SAME panel, is unaffected.
    const bystander = await app.inject(forgot('198.51.100.67', 'real-operator@example.com'));
    expect(bystander.statusCode).toBe(200);
  }, 60_000);
});

describe('auth tier is not loosened', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await enforcedApp();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('credential routes still cap at 10 per identity per IP', async () => {
    const req = {
      method: 'POST' as const,
      url: '/api/v1/tenant/auth/forgot-password',
      remoteAddress: '198.51.100.90',
      payload: { email: 'target@example.com' },
    };
    const tenth = await fire(app, 10, req);
    expect(tenth.statusCode).toBe(200);
    expect(tenth.headers['x-ratelimit-limit']).toBe('10');
    const over = await app.inject(req);
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
  });

  it('an operator session does not raise the auth cap', async () => {
    const op = await makeOperator('auth-cap');
    const req = {
      method: 'POST' as const,
      url: '/api/v1/tenant/auth/forgot-password',
      remoteAddress: '198.51.100.91',
      headers: { authorization: `Bearer ${op.accessToken}` },
      payload: { email: 'target2@example.com' },
    };
    const tenth = await fire(app, 10, req);
    expect(tenth.headers['x-ratelimit-limit']).toBe('10');
    expect((await app.inject(req)).statusCode).toBe(429);
  });
});

describe('POST /tenant/auth/refresh has its own per-IP bucket', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await enforcedApp();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('is not starved by ordinary browsing, and is bounded on its own', async () => {
    const ip = '198.51.100.120';
    expect((await fire(app, 101, anon(ip))).statusCode).toBe(429);

    const refresh = {
      method: 'POST' as const,
      url: '/api/v1/tenant/auth/refresh',
      remoteAddress: ip,
      payload: { refreshToken: 'not-a-real-token' },
    };
    const first = await app.inject(refresh);
    // Reached the handler (401 for the bogus token), not the exhausted bucket.
    expect(first.statusCode).toBe(401);
    expect(first.headers['x-ratelimit-limit']).toBe('60');
    expect((await fire(app, 59, refresh)).statusCode).toBe(401);
    const over = await app.inject(refresh);
    expect(over.statusCode).toBe(429);
    // Another address still refreshes.
    expect((await app.inject({ ...refresh, remoteAddress: '198.51.100.121' })).statusCode).toBe(401);
  });
});

describe('portal config keys on (slug, client IP) with a per-IP ceiling', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await enforcedApp();
  });
  afterEach(async () => {
    await app?.close();
  });

  const config = (slug: string, remoteAddress: string) => ({
    method: 'GET' as const,
    url: `/api/v1/portal/config/${slug}`,
    remoteAddress,
  });

  it('one slug exhausting its bucket does not affect another slug', async () => {
    const ip = '198.51.100.140';
    expect((await fire(app, 30, config('app-one', ip))).statusCode).toBe(404);
    expect((await app.inject(config('app-one', ip))).statusCode).toBe(429);
    expect((await app.inject(config('app-two', ip))).statusCode).toBe(404);
  });

  it('guessing a new slug per request is still bounded per IP', async () => {
    const ip = '198.51.100.141';
    for (let i = 0; i < 100; i++) {
      expect((await app.inject(config(`guess-${i}`, ip))).statusCode).toBe(404);
    }
    const over = await app.inject(config('guess-final', ip));
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
  });
});
