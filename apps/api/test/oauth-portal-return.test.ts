/**
 * Social sign-in that returns to the hosted portal. A caller may name the
 * Application's own portal sign-in page as the redirect URI, in place of the
 * one configured for the provider, and nothing else.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { registerOAuthProvider } from '../src/modules/oauth/providers/index.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const PORTAL = new URL(process.env.PUBLIC_PORTAL_URL ?? 'https://portal.test.invalid').origin;
const CONFIGURED = 'https://app.example/oauth/google/callback';

describe('OAuth sign-in returning to the hosted portal', () => {
  let app: FastifyInstance;
  let slug: string;
  let appId: string;
  let liveKey: string;
  const seen: { authUrl: string[]; exchange: string[] } = { authUrl: [], exchange: [] };

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: ({ config }) => {
        seen.authUrl.push(config.redirectUri);
        return 'https://mock.example/start';
      },
      exchange: async ({ config }) => {
        seen.exchange.push(config.redirectUri);
        return { providerAccountId: `g-${slug}`, email: `${slug}@example.com`, emailVerified: true };
      },
    });
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    seen.authUrl.length = 0;
    seen.exchange.length = 0;
    slug = `opr-${Math.random().toString(36).slice(2, 8)}`;
    const operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const auth = { authorization: `Bearer ${operator}` };
    appId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: auth, payload: { name: slug, slug } })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: auth,
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    configure = (hostedPortal) =>
      app.inject({
        method: 'PUT',
        url: `/api/v1/tenant/applications/${appId}/oauth-config/google`,
        headers: auth,
        payload: { clientId: 'gid', clientSecret: 'gsecret', redirectUri: CONFIGURED, hostedPortal },
      });
    await configure(true);
    await prisma.application.update({ where: { id: appId }, data: { hostedPortalEnabled: true } });
  });

  let configure: (hostedPortal: boolean | undefined) => Promise<LightMyRequestResponse>;

  const start = (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/google/start',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { state: 's', ...body },
    });
  const callback = (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/google/callback',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { code: 'c', ...body },
    });

  it('uses the portal sign-in page for both the authorization URL and the code exchange', async () => {
    const portalPage = `${PORTAL}/${slug}/oauth/callback`;
    expect((await start({ redirectUri: portalPage })).statusCode).toBe(200);
    const res = await callback({ redirectUri: portalPage });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { accessToken: string }).accessToken).toBeTruthy();
    expect(seen).toEqual({ authUrl: [portalPage], exchange: [portalPage] });
  });

  it('keeps the configured redirect URI when none is named', async () => {
    await start({});
    await callback({});
    expect(seen).toEqual({ authUrl: [CONFIGURED], exchange: [CONFIGURED] });
  });

  it.each([
    ['another application on the portal host', () => `${PORTAL}/${slug}-other/oauth/callback`],
    ['another page of this portal', () => `${PORTAL}/${slug}/login`],
    ["the operator's own app", () => 'https://app.example/elsewhere'],
  ])('refuses %s, before the provider is asked anything', async (_name, url) => {
    for (const res of [await start({ redirectUri: url() }), await callback({ redirectUri: url() })]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('OAUTH_REDIRECT_URI_NOT_ALLOWED');
    }
    expect(seen).toEqual({ authUrl: [], exchange: [] });
  });

  it('stores the portal flag with the provider and reports it in the public list', async () => {
    const providers = async () =>
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/oauth/providers',
          headers: { authorization: `Bearer ${liveKey}` },
        })
      ).json().data.providers;
    expect((await configure(true)).json().data).toEqual({ provider: 'google', configured: true, hostedPortal: true });
    expect(await providers()).toEqual([{ id: 'google', name: 'Google', hostedPortal: true }]);
    expect((await configure(undefined)).json().data.hostedPortal).toBe(false);
    expect(await providers()).toEqual([{ id: 'google', name: 'Google', hostedPortal: false }]);
  });

  it('refuses the portal page for a provider not offered there, saying where to turn it on and what to register', async () => {
    await configure(false);
    const portalPage = `${PORTAL}/${slug}/oauth/callback`;
    for (const res of [await start({ redirectUri: portalPage }), await callback({ redirectUri: portalPage })]) {
      expect(res.statusCode).toBe(400);
      const error = res.json().error as { code: string; fix: string };
      expect(error.code).toBe('OAUTH_PROVIDER_NOT_IN_PORTAL');
      expect(error.fix).toContain(portalPage);
      expect(error.fix).toContain('Offer in the hosted portal');
      expect(error.fix).toContain('Sign-in providers');
    }
    expect(seen).toEqual({ authUrl: [], exchange: [] });
    await start({});
    expect(seen.authUrl).toEqual([CONFIGURED]);
  });

  it('refuses the portal page once the portal is turned off', async () => {
    await prisma.application.update({ where: { id: appId }, data: { hostedPortalEnabled: false } });
    const res = await start({ redirectUri: `${PORTAL}/${slug}/oauth/callback` });
    expect(res.json().error.code).toBe('OAUTH_REDIRECT_URI_NOT_ALLOWED');
  });
});
