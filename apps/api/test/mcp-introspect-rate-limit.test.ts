/**
 * Which budget MCP token introspection spends, driven on the wire through the
 * real `buildApp()` wiring.
 *
 * The bug: `POST /api/v1/mcp/:slug/oauth/introspect` carried the sign-in tier's
 * 30 a minute, keyed on the caller's address because the secret key was only
 * checked inside the handler. A paid MCP server introspects on every tool call
 * from one backend address, so any real usage was refused with 429s. It now
 * spends the secret key's own budget (`RATE_LIMIT_API_KEY_MAX`), and a caller
 * without a valid secret key is held to the anonymous per-IP budget.
 *
 * Limits are neutered under NODE_ENV=test, so every case builds an app with
 * `REKEY_TEST_ENFORCE_RATE_LIMITS=1` (its own in-memory store), while fixtures
 * are created through an ordinary app so setup traffic spends no budget.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { GlobalRateLimitBudgets } from '../src/lib/rate-limit.js';

let fixtures: FastifyInstance;

beforeAll(async () => {
  fixtures = await buildApp({ logger: false });
  await fixtures.ready();
});

afterAll(async () => {
  await fixtures.close();
});

async function enforcedApp(rateLimitOverrides?: Partial<GlobalRateLimitBudgets>): Promise<FastifyInstance> {
  const prev = process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
  process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = '1';
  try {
    const app = await buildApp({ logger: false, ...(rateLimitOverrides ? { rateLimitOverrides } : {}) });
    await app.ready();
    return app;
  } finally {
    if (prev === undefined) delete process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
    else process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = prev;
  }
}

interface Fixture {
  slug: string;
  secretKey: string;
  secondKey: string;
  publicKey: string;
}

let seq = 0;
async function makeFixture(): Promise<Fixture> {
  const slug = `intro-${seq++}-${Math.random().toString(36).slice(2, 7)}`;
  const operator = await fixtures
    .inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `${slug}@example.com`, password: 'pw-one-two-three', workspaceName: 'Intro Co' },
    })
    .then((r) => (r.json().data as { accessToken: string }).accessToken);
  const auth = { authorization: `Bearer ${operator}` };
  const application = await fixtures
    .inject({ method: 'POST', url: '/api/v1/tenant/applications', headers: auth, payload: { name: 'Intro', slug } })
    .then((r) => r.json().data as { id: string; publicKey: string });
  const patched = await fixtures.inject({
    method: 'PATCH',
    url: `/api/v1/tenant/applications/${application.id}/auth-config`,
    headers: auth,
    payload: { mcpEnabled: true },
  });
  expect(patched.statusCode).toBe(200);
  const mint = (name: string) =>
    fixtures
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: auth,
        payload: { name, mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  return { slug, secretKey: await mint('mcp-server'), secondKey: await mint('other'), publicKey: application.publicKey };
}

function introspect(slug: string, bearer: string | null, ip: string) {
  return {
    method: 'POST' as const,
    url: `/api/v1/mcp/${slug}/oauth/introspect`,
    remoteAddress: ip,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams({ token: 'not-a-real-token' }).toString(),
  };
}

/** Fire `n` requests in concurrent batches of 10; return every status code. */
async function burn(app: FastifyInstance, n: number, req: ReturnType<typeof introspect>): Promise<number[]> {
  const statuses: number[] = [];
  for (let done = 0; done < n; done += 10) {
    const batch = Array.from({ length: Math.min(10, n - done) }, () => app.inject(req));
    for (const r of await Promise.all(batch)) statuses.push(r.statusCode);
  }
  return statuses;
}

describe('MCP token introspection rate limit', () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await makeFixture();
  });

  it('200 introspections a minute from one backend address with a secret key all succeed', async () => {
    const app = await enforcedApp();
    try {
      const ip = '203.0.113.40';
      const statuses = await burn(app, 200, introspect(fx.slug, fx.secretKey, ip));
      expect(statuses.filter((s) => s !== 200)).toEqual([]);
      // Counted against the key's own budget, not a sign-in or per-IP one.
      const next = await app.inject(introspect(fx.slug, fx.secretKey, ip));
      expect(next.statusCode).toBe(200);
      expect(next.json()).toEqual({ active: false });
      expect(next.headers['x-ratelimit-limit']).toBe('30000');
      expect(next.headers['x-ratelimit-remaining']).toBe(String(30000 - 201));
      // And the address's anonymous budget was never spent.
      const anon = await app.inject(introspect(fx.slug, null, ip));
      expect(anon.statusCode).toBe(401);
      expect(anon.headers['x-ratelimit-limit']).toBe('100');
      expect(anon.headers['x-ratelimit-remaining']).toBe('99');
    } finally {
      await app.close();
    }
  });

  it('the per-key budget still applies, per key', async () => {
    const app = await enforcedApp({ apiKey: 50 });
    try {
      const ip = '203.0.113.41';
      const statuses = await burn(app, 50, introspect(fx.slug, fx.secretKey, ip));
      expect(statuses.filter((s) => s !== 200)).toEqual([]);
      const over = await app.inject(introspect(fx.slug, fx.secretKey, ip));
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe('RATE_LIMITED');
      // Another key of the same Application, from the same address, has its own budget.
      expect((await app.inject(introspect(fx.slug, fx.secondKey, ip))).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('a caller without the secret key is held to the anonymous per-IP budget', async () => {
    // A large rejected-credential budget, so only the per-IP bucket can refuse.
    const app = await enforcedApp({ anonymous: 20, authFailuresPerIp: 1000 });
    try {
      const ip = '203.0.113.42';
      // No key, a publishable key and a forged secret key share the address's bucket.
      for (const bearer of [null, fx.publicKey, 'rp_live_forged']) {
        for (let i = 0; i < 6; i++) {
          const r = await app.inject(introspect(fx.slug, bearer, ip));
          expect(r.statusCode).toBe(401);
          expect(r.json().error).toBe('invalid_client');
        }
      }
      for (let i = 0; i < 2; i++) expect((await app.inject(introspect(fx.slug, null, ip))).statusCode).toBe(401);
      const over = await app.inject(introspect(fx.slug, fx.publicKey, ip));
      expect(over.statusCode).toBe(429);
      // The secret key is unaffected by its address's anonymous budget.
      expect((await app.inject(introspect(fx.slug, fx.secretKey, ip))).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('rejected credentials still block the address', async () => {
    const app = await enforcedApp({ authFailuresPerIp: 5 });
    try {
      const ip = '203.0.113.43';
      for (let i = 0; i < 5; i++) {
        expect((await app.inject(introspect(fx.slug, 'rp_live_forged', ip))).statusCode).toBe(401);
      }
      const blocked = await app.inject(introspect(fx.slug, 'rp_live_forged', ip));
      expect(blocked.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('operator MCP introspection is counted against the PAT operator, not a sign-in limit', async () => {
    const session = await fixtures
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-intro-${seq++}@example.com`, password: 'pw-one-two-three', workspaceName: 'Op Intro' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const pat = await fixtures
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/api-tokens',
        headers: { authorization: `Bearer ${session}` },
        payload: { name: 'resource-server', scopes: ['read'] },
      })
      .then((r) => (r.json().data as { rawToken: string }).rawToken);
    const app = await enforcedApp();
    try {
      const req = {
        method: 'POST' as const,
        url: '/api/v1/tenant/mcp/oauth/introspect',
        remoteAddress: '203.0.113.45',
        headers: { authorization: `Bearer ${pat}`, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ token: 'not-a-real-token' }).toString(),
      };
      // The old sign-in cap here was 30 a minute.
      const statuses = await burn(app, 60, req);
      expect(statuses.filter((s) => s !== 200)).toEqual([]);
      const next = await app.inject(req);
      expect(next.json()).toEqual({ active: false });
      expect(next.headers['x-ratelimit-limit']).toBe('600');
    } finally {
      await app.close();
    }
  });

  it("a secret key of another Application is counted against that key and refused", async () => {
    const other = await makeFixture();
    const app = await enforcedApp();
    try {
      const r = await app.inject(introspect(fx.slug, other.secretKey, '203.0.113.44'));
      expect(r.statusCode).toBe(401);
      expect(r.json().error).toBe('invalid_client');
      expect(r.headers['x-ratelimit-limit']).toBe('30000');
    } finally {
      await app.close();
    }
  });
});
