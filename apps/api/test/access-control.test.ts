/**
 * Per-Application network access controls:
 *   - IP allowlist enforced on server-side secret-key calls (requireApiKey).
 *   - Per-app CORS origins folded into the API CORS allowlist.
 *
 * inject() requests originate from 127.0.0.1 and trustProxy is off in test, so
 * `req.ip` is 127.0.0.1 — we drive the allowlist relative to that. Domain
 * tables are truncated before every test (test/setup.ts), so each case
 * bootstraps its own operator + app + key inside the test body.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

interface Ctx {
  operatorToken: string;
  appId: string;
  liveKey: string;
}

describe('per-app access controls (IP allowlist + CORS)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  async function bootstrap(): Promise<Ctx> {
    const slug = `acl-${n++}-${Math.random().toString(36).slice(2, 7)}`;
    const operatorToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: 'pw-one-two-three', workspaceName: 'ACL Co' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'ACL App', slug },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'acl-key', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    return { operatorToken, appId, liveKey };
  }

  function setAccess(ctx: Ctx, body: { ipAllowlist?: string[]; corsOrigins?: string[] }) {
    return app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${ctx.appId}/access`,
      headers: { authorization: `Bearer ${ctx.operatorToken}` },
      payload: body,
    });
  }

  function callMe(ctx: Ctx) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/me/',
      headers: { authorization: `Bearer ${ctx.liveKey}` },
    });
  }

  it('no allowlist → secret key works from any IP', async () => {
    const ctx = await bootstrap();
    expect((await callMe(ctx)).statusCode).toBe(200);
  });

  it('minting a TEST-mode API key from the panel route is disabled (live still works)', async () => {
    const ctx = await bootstrap();
    const mint = (mode: string) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${ctx.appId}/api-keys`,
        headers: { authorization: `Bearer ${ctx.operatorToken}` },
        payload: { name: `k-${mode}`, mode },
      });
    const test = await mint('test');
    expect(test.statusCode).toBe(400);
    expect(test.json().error.code).toBe('TEST_API_KEYS_DISABLED');
    expect((await mint('live')).statusCode).toBe(201);
  });

  it('allowlist excluding the caller IP → 403 IP_NOT_ALLOWED, then allowed once it includes it', async () => {
    const ctx = await bootstrap();
    expect((await setAccess(ctx, { ipAllowlist: ['10.0.0.0/8'] })).statusCode).toBe(200);
    const blocked = await callMe(ctx);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('IP_NOT_ALLOWED');

    expect((await setAccess(ctx, { ipAllowlist: ['127.0.0.1', '::1'] })).statusCode).toBe(200);
    expect((await callMe(ctx)).statusCode).toBe(200);

    // Emptying the allowlist re-opens it.
    expect((await setAccess(ctx, { ipAllowlist: [] })).statusCode).toBe(200);
    expect((await callMe(ctx)).statusCode).toBe(200);
  });

  it('rejects malformed allowlist entries (validation)', async () => {
    const ctx = await bootstrap();
    const res = await setAccess(ctx, { ipAllowlist: ['not an ip!!'] });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('per-app CORS: a registered origin passes preflight; unregistered ones do not', async () => {
    const ctx = await bootstrap();
    const origin = `https://acl-cors-${Math.random().toString(36).slice(2, 8)}.example`;

    // Unregistered → preflight omits the ACAO header.
    const before = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/me/',
      headers: { origin, 'access-control-request-method': 'GET' },
    });
    expect(before.headers['access-control-allow-origin']).toBeUndefined();

    // Register it for this app (refreshes the cache).
    expect((await setAccess(ctx, { corsOrigins: [origin] })).statusCode).toBe(200);

    const after = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/me/',
      headers: { origin, 'access-control-request-method': 'GET' },
    });
    expect(after.headers['access-control-allow-origin']).toBe(origin);

    // A different, unregistered origin stays blocked.
    const other = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/me/',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
