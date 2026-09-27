/**
 * `GET /api/v1/auth/oauth/providers`, the list a sign-in page renders its
 * social buttons from (#463). It is reachable with the publishable key, so the
 * assertions that matter most are what it leaves OUT: every other Application's
 * providers, and every field of the operator's OAuth config except the id.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { oauthService } from '../src/modules/oauth/oauth.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const URL = '/api/v1/auth/oauth/providers';

interface Fixture {
  applicationId: string;
  publicKey: string;
  liveKey: string;
  mint: (scopes: string[]) => Promise<string>;
}

const CLIENT_ID = 'client-id-that-must-not-leak';
const CLIENT_SECRET = 'client-secret-that-must-not-leak';
const REDIRECT_URI = 'https://app.example/oauth/callback-that-must-not-leak';

describe('GET /api/v1/auth/oauth/providers', () => {
  let app: FastifyInstance;
  let a: Fixture;
  let b: Fixture;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function createApp(label: string): Promise<Fixture> {
    const slug = `opl-${label}-${Math.random().toString(36).slice(2, 8)}`;
    const tenant = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name: `T ${slug}`, ownerEmail: `op-${slug}@example.com` },
    });
    expect(tenant.statusCode, tenant.body).toBeLessThan(300);
    const application = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/applications',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { tenantId: tenant.json().data.id, name: `A ${slug}`, slug },
    });
    expect(application.statusCode, application.body).toBeLessThan(300);
    const { id, publicKey } = application.json().data as { id: string; publicKey: string };
    const mint = async (keyScopes: string[]): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: keyScopes.join('+'), mode: 'live', scopes: keyScopes },
      });
      expect(res.statusCode, res.body).toBeLessThan(300);
      return (res.json().data as { rawKey: string }).rawKey;
    };
    return { applicationId: id, publicKey, liveKey: await mint(['*']), mint };
  }

  async function configure(applicationId: string, provider: string, issuerUrl?: string): Promise<void> {
    await oauthService.setProviderConfig({
      applicationId,
      providerName: provider,
      public: {
        clientId: `${CLIENT_ID}-${provider}`,
        redirectUri: REDIRECT_URI,
        scopes: ['openid', 'email'],
        ...(issuerUrl !== undefined && { issuerUrl }),
      },
      clientSecret: `${CLIENT_SECRET}-${provider}`,
    });
  }

  const list = (key: string | undefined, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: URL,
      headers: { ...(key !== undefined && { authorization: `Bearer ${key}` }), ...headers },
    });

  beforeEach(async () => {
    a = await createApp('a');
    b = await createApp('b');
  });

  it('is empty for an Application with no providers', async () => {
    const res = await list(a.publicKey);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { providers: [] } });
  });

  it('lists only providers with both a public config and a client secret', async () => {
    await configure(a.applicationId, 'github');
    await configure(a.applicationId, 'google');
    // A public entry with no stored secret, the state `/:provider/start`
    // refuses with OAUTH_PROVIDER_NOT_CONFIGURED. A button for it would be dead.
    const row = await prisma.application.findUniqueOrThrow({ where: { id: a.applicationId } });
    await prisma.application.update({
      where: { id: a.applicationId },
      data: {
        oauthConfig: {
          ...(row.oauthConfig as Record<string, unknown>),
          discord: { clientId: 'd', redirectUri: REDIRECT_URI },
        } as never,
      },
    });

    const res = await list(a.publicKey);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.providers).toEqual([
      { id: 'google', name: 'Google' },
      { id: 'github', name: 'GitHub' },
    ]);
  });

  it('never returns anything but the id and display name', async () => {
    await configure(a.applicationId, 'google');
    await configure(a.applicationId, 'oidc', 'https://issuer.example');

    const res = await list(a.publicKey);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    expect(Object.keys(body.data)).toEqual(['providers']);
    const providers = body.data.providers as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(2);
    for (const p of providers) expect(Object.keys(p).sort()).toEqual(['id', 'name']);
    expect(providers.find((p) => p.id === 'oidc')?.name).toBe('SSO');
    for (const leaked of [CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, 'issuer.example', 'openid']) {
      expect(res.body).not.toContain(leaked);
    }
  });

  it('leaves out a half-configured OIDC entry, which start refuses too', async () => {
    await configure(a.applicationId, 'google');
    await oauthService.setProviderConfig({
      applicationId: a.applicationId,
      providerName: 'oidc',
      public: { clientId: 'o', redirectUri: REDIRECT_URI },
      clientSecret: 'oidc-secret',
    });

    expect((await list(a.publicKey)).json().data.providers).toEqual([{ id: 'google', name: 'Google' }]);

    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/oidc/start',
      headers: { authorization: `Bearer ${a.publicKey}` },
      payload: { state: 's' },
    });
    expect(start.statusCode, start.body).toBe(400);
    expect(start.json().error.code).toBe('OAUTH_PROVIDER_NOT_CONFIGURED');
    expect(start.json().error.fix).toContain('issuerUrl');
  });

  it('drops a provider once the operator removes it', async () => {
    await configure(a.applicationId, 'google');
    await configure(a.applicationId, 'discord');
    await oauthService.removeProviderConfig({ applicationId: a.applicationId, providerName: 'google' });
    const res = await list(a.publicKey);
    expect(res.json().data.providers).toEqual([{ id: 'discord', name: 'Discord' }]);
  });

  it('answers the secret key the same as the publishable key', async () => {
    await configure(a.applicationId, 'google');
    const viaPub = await list(a.publicKey);
    const viaSecret = await list(a.liveKey);
    expect(viaSecret.statusCode, viaSecret.body).toBe(200);
    expect(viaSecret.json()).toEqual(viaPub.json());
  });

  it('accepts a secret key holding only auth:read, and refuses one without it', async () => {
    await configure(a.applicationId, 'google');
    const readOnly = await a.mint(['auth:read']);
    expect((await list(readOnly)).statusCode).toBe(200);
    const billingOnly = await a.mint(['billing:read']);
    const refused = await list(billingOnly);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
  });

  it('is cacheable for a short time, privately, and varies on the credential', async () => {
    const res = await list(a.publicKey);
    expect(res.headers['cache-control']).toBe('private, max-age=60');
    expect(String(res.headers['vary'])).toMatch(/Authorization/);
  });

  it('refuses a missing, unknown, or malformed key', async () => {
    const none = await list(undefined);
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('API_KEY_MISSING');

    const unknownPub = await list(`rp_pub_${'0'.repeat(32)}`);
    expect(unknownPub.statusCode).toBe(401);
    expect(unknownPub.json().error.code).toBe('PUBLISHABLE_KEY_INVALID');

    const unknownSecret = await list(`rp_live_${'0'.repeat(40)}`);
    expect(unknownSecret.statusCode).toBe(401);
    expect(unknownSecret.json().error.code).toBe('API_KEY_INVALID');
  });

  it("returns each Application's own providers and never another's", async () => {
    await configure(a.applicationId, 'google');
    await configure(b.applicationId, 'github');

    for (const key of [a.publicKey, a.liveKey]) {
      expect((await list(key)).json().data.providers).toEqual([{ id: 'google', name: 'Google' }]);
    }
    for (const key of [b.publicKey, b.liveKey]) {
      expect((await list(key)).json().data.providers).toEqual([{ id: 'github', name: 'GitHub' }]);
    }
  });

  it("refuses a browser Origin outside the Application's allowlist", async () => {
    await configure(a.applicationId, 'google');
    await prisma.application.update({
      where: { id: a.applicationId },
      data: { corsOrigins: ['https://allowed.example'] },
    });
    const blocked = await list(a.publicKey, { origin: 'https://other.example' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    const allowed = await list(a.publicKey, { origin: 'https://allowed.example' });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it('is rate-limited like the other publishable-key reads', async () => {
    process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = '1';
    const limited = await buildApp({ logger: false, rateLimitOverrides: { anonymous: 3, apiKey: 3 } }).finally(
      () => delete process.env.REKEY_TEST_ENFORCE_RATE_LIMITS,
    );
    await limited.ready();
    try {
      const call = () =>
        limited.inject({
          method: 'GET',
          url: URL,
          remoteAddress: '203.0.113.63',
          headers: { authorization: `Bearer ${a.publicKey}` },
        });
      for (let i = 0; i < 3; i++) expect((await call()).statusCode).toBe(200);
      const over = await call();
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});
