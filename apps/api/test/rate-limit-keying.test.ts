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
 * user, 30000 per secret key, 60 refreshes per IP, auth routes 10.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import {
  resolveGlobalBudgets,
  unattributedAttemptSubject,
  type GlobalRateLimitBudgets,
} from '../src/lib/rate-limit.js';

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
async function enforcedApp(
  trustedProxies?: string,
  rateLimitOverrides?: Partial<GlobalRateLimitBudgets>,
): Promise<FastifyInstance> {
  const prevEnforce = process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
  const prevTrust = process.env.TRUSTED_PROXIES;
  process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = '1';
  if (trustedProxies === undefined) delete process.env.TRUSTED_PROXIES;
  else process.env.TRUSTED_PROXIES = trustedProxies;
  try {
    const app = await buildApp({ logger: false, ...(rateLimitOverrides ? { rateLimitOverrides } : {}) });
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
    let applicationId: string;

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
      applicationId = application.id;
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
      expect(res.headers['x-ratelimit-limit']).toBe('30000');
      expect(res.headers['x-ratelimit-remaining']).toBe('29999');
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

    // GET /auth/me verifies the token itself, with no key hook in front of it.
    // It used to do that inside the handler, after the limiter had already
    // counted the request against the caller's IP, so a backend resolving many
    // users from one address shared 100 requests a minute between all of them.
    it('GET /auth/me is keyed on the end user, not the IP', async () => {
      const signUp = (email: string) =>
        fixtures
          .inject({
            method: 'POST',
            url: '/api/v1/auth/sign-up',
            headers: { authorization: `Bearer ${publicKey}` },
            payload: { email, password: 'correct-horse-battery' },
          })
          .then((r) => (r.json().data as { accessToken: string }).accessToken);
      const alice = await signUp('rl-alice@example.com');
      const bob = await signUp('rl-bob@example.com');
      const authMe = (token: string) => ({
        method: 'GET' as const,
        url: '/api/v1/auth/me?include=device',
        remoteAddress: '203.0.113.22',
        headers: { 'x-rekey-user-token': token },
      });

      expect((await fire(app, 101, anon('203.0.113.22'))).statusCode).toBe(429);

      const first = await app.inject(authMe(alice));
      expect(first.statusCode).toBe(200);
      expect(first.headers['x-ratelimit-limit']).toBe('600');
      expect(first.headers['x-ratelimit-remaining']).toBe('599');
      const second = await app.inject(authMe(bob));
      expect(second.statusCode).toBe(200);
      expect(second.headers['x-ratelimit-remaining']).toBe('599');
    });

    // Refused before the limiter runs, so a refusal other than 401 (a frozen
    // Application here) must still reach the rejected-credential limiter, or a
    // held token buys unmetered lookups.
    it('GET /auth/me refusals other than 401 are still counted per IP', async () => {
      const token = await fixtures
        .inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${publicKey}` },
          payload: { email: 'rl-frozen@example.com', password: 'correct-horse-battery' },
        })
        .then((r) => (r.json().data as { accessToken: string }).accessToken);
      await prisma.application.update({ where: { id: applicationId }, data: { disabledAt: new Date() } });
      const req = {
        method: 'GET' as const,
        url: '/api/v1/auth/me',
        remoteAddress: '203.0.113.23',
        headers: { 'x-rekey-user-token': token },
      };
      for (let i = 0; i < 100; i++) {
        const r = await app.inject(req);
        expect(r.statusCode).toBe(403);
        expect(r.json().error.code).toBe('APPLICATION_DISABLED');
      }
      const over = await app.inject(req);
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe('RATE_LIMITED');
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

/**
 * The per-Application auth ceiling has its own budget (RATE_LIMIT_AUTH_CEILING_MAX,
 * 3000) instead of reusing RATE_LIMIT_MAX (100), and what one client IP may
 * spend of it is still RATE_LIMIT_MAX. At 100 per Application, one address with
 * the public publishable key could refuse every sign-in to the Application.
 */
describe('per-Application auth ceiling', () => {
  let publicKey: string;
  let secretKey: string;

  beforeEach(async () => {
    const tenant = await fixtures
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'T', ownerEmail: 'ceil-owner@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    const application = await fixtures
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'A', slug: 'ceil-app' },
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
    publicKey = application.publicKey;
    secretKey = key.rawKey;
  });

  // Distinct emails, so the 10-per-identity cap never trips: only the ceiling
  // and its per-IP share can refuse these.
  let seq = 0;
  const forgot = (ip: string, bearer: string) => ({
    method: 'POST' as const,
    url: '/api/v1/auth/forgot-password',
    remoteAddress: ip,
    headers: { authorization: `Bearer ${bearer}` },
    payload: { email: `ceil-${seq++}@example.com` },
  });

  async function spend(app: FastifyInstance, n: number, ip: string, bearer = publicKey): Promise<void> {
    for (let i = 0; i < n; i++) {
      const r = await app.inject(forgot(ip, bearer));
      expect(r.statusCode, `request ${i + 1} from ${ip}`).not.toBe(429);
    }
  }

  it('one client IP is still held to RATE_LIMIT_MAX, and that does not spend the Application', async () => {
    const app = await enforcedApp();
    try {
      await spend(app, 100, '198.51.100.120');
      const over = await app.inject(forgot('198.51.100.120', publicKey));
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe('RATE_LIMITED');
      // The old ceiling was RATE_LIMIT_MAX per Application: this bystander
      // would have been refused along with the sprayer.
      const bystander = await app.inject(forgot('198.51.100.121', publicKey));
      expect(bystander.statusCode).not.toBe(429);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('the Application ceiling uses its own budget, independent of RATE_LIMIT_MAX', async () => {
    // A small ceiling so it can be exhausted on the wire; the anonymous budget
    // (RATE_LIMIT_MAX) stays at its default of 100.
    const app = await enforcedApp(undefined, { authCeiling: 150 });
    try {
      await spend(app, 100, '198.51.100.130');
      await spend(app, 50, '198.51.100.131');
      const overSecondIp = await app.inject(forgot('198.51.100.131', publicKey));
      expect(overSecondIp.statusCode).toBe(429);
      // A third address has spent nothing of its own: the Application is out.
      const third = await app.inject(forgot('198.51.100.132', publicKey));
      expect(third.statusCode).toBe(429);
      // Anonymous traffic from a fresh address still gets RATE_LIMIT_MAX.
      const anonRes = await app.inject(anon('198.51.100.133'));
      expect(anonRes.statusCode).toBe(200);
      expect(anonRes.headers['x-ratelimit-limit']).toBe('100');
    } finally {
      await app.close();
    }
  }, 60_000);

  it('a secret key is not held to the per-IP share (one backend address serves every user)', async () => {
    const app = await enforcedApp();
    try {
      await spend(app, 120, '198.51.100.140', secretKey);
    } finally {
      await app.close();
    }
  }, 60_000);

  // A backend signing users in with its secret key sends every request from
  // its own address, so a password spray through its sign-in form had no
  // per-address limit at all, only the 3000-a-minute Application ceiling.
  describe('secret-key traffic that names the visitor in X-Rekey-Client-Ip', () => {
    const forgotFor = (visitor: string | string[], backendIp = '198.51.100.150') => ({
      ...forgot(backendIp, secretKey),
      headers: { authorization: `Bearer ${secretKey}`, 'x-rekey-client-ip': visitor as string },
    });

    it('holds each visitor to RATE_LIMIT_MAX, and one visitor spending it leaves the next alone', async () => {
      const app = await enforcedApp();
      try {
        for (let i = 0; i < 100; i++) {
          const r = await app.inject(forgotFor('203.0.113.7'));
          expect(r.statusCode, `request ${i + 1}`).not.toBe(429);
        }
        const over = await app.inject(forgotFor('203.0.113.7'));
        expect(over.statusCode).toBe(429);
        expect(over.json().error.code).toBe('RATE_LIMITED');
        // Same backend, same key, another visitor.
        const next = await app.inject(forgotFor('203.0.113.8'));
        expect(next.statusCode).not.toBe(429);
        // IPv6, and the IPv4-mapped form of the first visitor is the same visitor.
        expect((await app.inject(forgotFor('2001:db8::1'))).statusCode).not.toBe(429);
        expect((await app.inject(forgotFor('::ffff:203.0.113.7'))).statusCode).toBe(429);
      } finally {
        await app.close();
      }
    }, 60_000);

    it('ignores a malformed or repeated header: the call stays unattributed, not per-IP limited', async () => {
      const app = await enforcedApp();
      try {
        for (let i = 0; i < 60; i++) {
          const r = await app.inject(forgotFor('not-an-ip'));
          expect(r.statusCode, `malformed ${i + 1}`).not.toBe(429);
        }
        for (let i = 0; i < 60; i++) {
          const r = await app.inject(forgotFor(['203.0.113.9', '203.0.113.9']));
          expect(r.statusCode, `repeated ${i + 1}`).not.toBe(429);
        }
      } finally {
        await app.close();
      }
    }, 60_000);

    it('is not believed from a publishable key: the socket address stays the client', async () => {
      const app = await enforcedApp();
      try {
        // Rotating the header per request would mint a fresh bucket each time
        // if it were read here.
        for (let i = 0; i < 100; i++) {
          const r = await app.inject({
            ...forgot('198.51.100.160', publicKey),
            headers: { authorization: `Bearer ${publicKey}`, 'x-rekey-client-ip': `203.0.113.${i + 1}` },
          });
          expect(r.statusCode, `request ${i + 1}`).not.toBe(429);
        }
        const over = await app.inject({
          ...forgot('198.51.100.160', publicKey),
          headers: { authorization: `Bearer ${publicKey}`, 'x-rekey-client-ip': '203.0.113.250' },
        });
        expect(over.statusCode).toBe(429);
      } finally {
        await app.close();
      }
    }, 60_000);
  });

  // Traffic with no visitor address (a backend that does not forward one, or
  // a proxy the API cannot identify) gets a per-Application cap on FAILED
  // attempts instead.
  describe('unattributed failed attempts', () => {
    let wrong = 0;
    const signIn = (
      bearer: string,
      remoteAddress: string,
      opts: { email?: string; password?: string; headers?: Record<string, string> } = {},
    ) => ({
      method: 'POST' as const,
      url: '/api/v1/auth/sign-in',
      remoteAddress,
      headers: { authorization: `Bearer ${bearer}`, ...opts.headers },
      payload: { email: opts.email ?? `spray-${wrong++}@example.com`, password: opts.password ?? 'Summer2026!' },
    });
    // Rows survive between tests in this file, so count only this test's.
    let testStart = new Date();
    beforeEach(() => {
      testStart = new Date();
    });
    const capEvents = () =>
      prisma.securityEvent.count({
        where: { type: 'auth.unattributed_failure_cap_reached', createdAt: { gte: testStart } },
      });

    it('past the cap, refuses only accounts that already failed; everyone else, and every other route, proceeds', async () => {
      // A real user of the Application, created before the spray.
      const real = await fixtures.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${secretKey}` },
        payload: { email: 'real-user@example.com', password: 'correct-horse-battery' },
      });
      expect(real.statusCode).toBe(201);

      const app = await enforcedApp(undefined, { authUnattributedFailures: 5 });
      const backend = '198.51.100.170';
      try {
        // Successful, non-failing traffic does not count toward it.
        await spend(app, 20, backend, secretKey);
        for (let i = 0; i < 5; i++) {
          const r = await app.inject(signIn(secretKey, backend, { email: `victim-${i}@example.com` }));
          expect(r.statusCode, `failure ${i + 1}`).toBe(401);
          expect(r.json().error.code).toBe('INVALID_CREDENTIALS');
        }
        // An email that already failed this window is refused.
        const repeat = await app.inject(signIn(secretKey, backend, { email: 'victim-0@example.com' }));
        expect(repeat.statusCode).toBe(429);
        expect(repeat.json().error.code).toBe('RATE_LIMITED');
        // A real user with a different email still signs in.
        const ok = await app.inject(
          signIn(secretKey, backend, { email: 'real-user@example.com', password: 'correct-horse-battery' }),
        );
        expect(ok.statusCode).toBe(200);
        // A fresh email gets its one attempt (a spray costs one guess per account).
        expect((await app.inject(signIn(secretKey, backend))).statusCode).toBe(401);
        // Sign-up and the other auth routes are never refused by this cap.
        const signUp = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          remoteAddress: backend,
          headers: { authorization: `Bearer ${secretKey}` },
          // An email that already failed a sign-in this window, on purpose.
          payload: { email: 'victim-1@example.com', password: 'correct-horse-battery' },
        });
        expect(signUp.statusCode).toBe(201);
        expect((await app.inject(forgot(backend, secretKey))).statusCode).toBe(200);
        // A backend call that names its visitor is limited per visitor instead.
        const attributed = await app.inject(
          signIn(secretKey, backend, { email: 'victim-0@example.com', headers: { 'x-rekey-client-ip': '203.0.113.20' } }),
        );
        expect(attributed.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    }, 60_000);

    it('tells the operator once per window that the backend is not forwarding the visitor address', async () => {
      const app = await enforcedApp(undefined, { authUnattributedFailures: 3 });
      try {
        for (let i = 0; i < 3; i++) await app.inject(signIn(secretKey, '198.51.100.173'));
        expect(await capEvents()).toBe(1);
        // Further failures in the same window add nothing.
        for (let i = 0; i < 4; i++) await app.inject(signIn(secretKey, '198.51.100.173'));
        expect(await capEvents()).toBe(1);
        const [event] = await prisma.securityEvent.findMany({
          where: { type: 'auth.unattributed_failure_cap_reached', createdAt: { gte: testStart } },
        });
        expect(event?.applicationId).not.toBeNull();
        expect(event?.tenantId).not.toBeNull();
      } finally {
        await app.close();
      }
    }, 60_000);

    it('failures from a named visitor do not spend the unattributed cap', async () => {
      const app = await enforcedApp(undefined, { authUnattributedFailures: 5 });
      try {
        for (let i = 0; i < 8; i++) {
          const r = await app.inject(
            signIn(secretKey, '198.51.100.172', {
              email: 'named-0@example.com',
              headers: { 'x-rekey-client-ip': `203.0.113.${30 + i}` },
            }),
          );
          expect(r.statusCode, `failure ${i + 1}`).toBe(401);
        }
        // Unattributed now, for an email that failed only while attributed.
        const r = await app.inject(signIn(secretKey, '198.51.100.172', { email: 'named-0@example.com' }));
        expect(r.statusCode).toBe(401);
        expect(await capEvents()).toBe(0);
      } finally {
        await app.close();
      }
    }, 60_000);

    it('applies the same cap to publishable-key traffic through a proxy the API cannot identify', async () => {
      const app = await enforcedApp(undefined, { authUnattributedFailures: 5 });
      // A private-network peer that forwards without the proxy secret: not vouched.
      const viaUnknownProxy = { 'x-forwarded-for': '203.0.113.40' };
      try {
        for (let i = 0; i < 5; i++) {
          const r = await app.inject(
            signIn(publicKey, '10.9.0.5', { email: `proxied-${i}@example.com`, headers: viaUnknownProxy }),
          );
          expect(r.statusCode, `failure ${i + 1}`).toBe(401);
        }
        const refused = await app.inject(
          signIn(publicKey, '10.9.0.5', { email: 'proxied-2@example.com', headers: viaUnknownProxy }),
        );
        expect(refused.statusCode).toBe(429);
        expect(refused.json().error.code).toBe('RATE_LIMITED');
        const fresh = await app.inject(signIn(publicKey, '10.9.0.5', { headers: viaUnknownProxy }));
        expect(fresh.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    }, 60_000);
  });

  describe('which attempts the unattributed cap can see', () => {
    const req = (url: string, body: unknown) =>
      ({ routeOptions: { url }, body }) as unknown as Parameters<typeof unattributedAttemptSubject>[0];
    const mfa = (token: string) => (token === 'good-token' ? 'eu_123' : null);

    it('sign-in keys on the normalised email, MFA on the pending user, and nothing else is watched', () => {
      expect(unattributedAttemptSubject(req('/api/v1/auth/sign-in', { email: ' Victim@Example.com ' }), mfa)).toBe(
        'email:victim@example.com',
      );
      expect(unattributedAttemptSubject(req('/api/v1/auth/sign-in', {}), mfa)).toBeNull();
      expect(
        unattributedAttemptSubject(req('/api/v1/auth/mfa-verify', { mfaChallengeToken: 'good-token', code: '1' }), mfa),
      ).toBe('eu:eu_123');
      expect(
        unattributedAttemptSubject(req('/api/v1/auth/mfa-verify', { mfaChallengeToken: 'forged', code: '1' }), mfa),
      ).toBeNull();
      for (const url of [
        '/api/v1/auth/sign-up',
        '/api/v1/auth/forgot-password',
        '/api/v1/auth/reset-password',
        '/api/v1/auth/magic-link/request',
        '/api/v1/auth/verify-email',
      ]) {
        expect(unattributedAttemptSubject(req(url, { email: 'victim@example.com' }), mfa), url).toBeNull();
      }
    });
  });
});

describe('budget defaults', () => {
  it('sizes the per-key and auth-ceiling budgets for a 50k-DAU Application', () => {
    const b = resolveGlobalBudgets({ RATE_LIMIT_MAX: 100 });
    expect(b.apiKey).toBe(30_000);
    expect(b.authCeiling).toBe(3000);
    expect(b.anonymous).toBe(100);
    expect(b.authFailuresPerIp).toBe(100);
    expect(b.authUnattributedFailures).toBe(300);
    expect(
      resolveGlobalBudgets({ RATE_LIMIT_MAX: 100, RATE_LIMIT_AUTH_UNATTRIBUTED_FAILURE_MAX: 50 })
        .authUnattributedFailures,
    ).toBe(50);
  });

  it('RATE_LIMIT_AUTH_CEILING_MAX sets the ceiling without touching RATE_LIMIT_MAX, and the reverse', () => {
    const own = resolveGlobalBudgets({ RATE_LIMIT_MAX: 100, RATE_LIMIT_AUTH_CEILING_MAX: 600 });
    expect(own.authCeiling).toBe(600);
    expect(own.anonymous).toBe(100);
    const raisedAnon = resolveGlobalBudgets({ RATE_LIMIT_MAX: 200, RATE_LIMIT_AUTH_CEILING_MAX: 600 });
    expect(raisedAnon.authCeiling).toBe(600);
  });

  it('an unset ceiling and key budget never fall below a raised RATE_LIMIT_MAX', () => {
    const b = resolveGlobalBudgets({ RATE_LIMIT_MAX: 50_000 });
    expect(b.authCeiling).toBe(50_000);
    expect(b.apiKey).toBe(50_000);
  });
});
