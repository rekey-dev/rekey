/**
 * Where a session comes from: the platform, OS, browser, app version and
 * country recorded on the refresh row and rolled up onto the end user. The
 * `client` body hint, `X-Rekey-Client-User-Agent` (believed only from a secret
 * key) and `CF-IPCountry` (never for a secret key).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { describeClientUserAgent } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { recordActivitySafely } from '../src/modules/end-users/daily-activity.js';

const PASSWORD = 'pw-one-two-three';
const RACERS = 8;
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const FIREFOX_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
const PROXY_SECRET = 'proxy-secret-for-client-platform-tests';
const CALLER_SECRET = 'caller-secret-for-client-platform-tests';
const PORTAL_NODE_UA = 'node';

/** How a test request reaches the API. */
interface Route {
  /** `proxy`: through our Traefik, which adds X-Rekey-Proxy-Secret. `direct`: a hit on the origin. */
  via?: 'proxy' | 'direct';
  /** `trusting`: TRUST_CF_IPCOUNTRY on. `default`: the shipped default, off. */
  app?: 'trusting' | 'default';
}

type Json = Record<string, unknown>;

describe('Session client platform and country', () => {
  let app: FastifyInstance;
  let defaultApp: FastifyInstance;
  let operator: string;
  let appId: string;
  let secretKey: string;
  let publicKey: string;

  beforeAll(async () => {
    app = await buildApp({
      logger: false,
      apiProxy: { secret: PROXY_SECRET, callerSecret: CALLER_SECRET },
      trustCfIpCountry: true,
    });
    defaultApp = await buildApp({ logger: false, apiProxy: { secret: PROXY_SECRET, callerSecret: CALLER_SECRET } });
    await app.ready();
    await defaultApp.ready();
  });
  afterAll(async () => {
    await app.close();
    await defaultApp.close();
  });

  const op = (): { authorization: string } => ({ authorization: `Bearer ${operator}` });

  beforeEach(async () => {
    const slug = `cp-${Math.random().toString(36).slice(2, 8)}`;
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const created = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: op(), payload: { name: 'CP', slug } })
      .then((r) => r.json().data as { id: string; publicKey: string });
    appId = created.id;
    publicKey = created.publicKey;
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: op(),
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await prisma.webhookEndpoint.create({
      data: { applicationId: appId, url: 'https://example.invalid/hook', secret: 'whsec_x', events: ['*'] },
    });
  });

  async function call(
    path: string,
    key: string,
    payload: Json,
    headers: Record<string, string> = {},
    route: Route = {},
  ): Promise<{ status: number; data: Json }> {
    const target = route.app === 'default' ? defaultApp : app;
    const res = await target.inject({
      method: 'POST',
      url: `/api/v1/auth/${path}`,
      headers: {
        authorization: `Bearer ${key}`,
        ...(route.via === 'direct' ? {} : { 'x-rekey-proxy-secret': PROXY_SECRET }),
        ...headers,
      },
      payload,
    });
    return { status: res.statusCode, data: (res.json().data ?? {}) as Json };
  }

  async function latestSession(email: string) {
    const user = await prisma.endUser.findFirstOrThrow({ where: { applicationId: appId, email } });
    const session = await prisma.refreshToken.findFirstOrThrow({
      where: { endUserId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    return { user, session };
  }

  async function sessionCreatedPayloads(): Promise<Json[]> {
    const rows = await prisma.webhookDelivery.findMany({
      where: { applicationId: appId, eventType: 'session.created' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => (r.payload as { data: Json }).data);
  }

  it('a browser sign-in records its platform, OS, browser and CF country', async () => {
    const r = await call('sign-up', publicKey, { email: 'web@example.com', password: PASSWORD }, {
      'user-agent': CHROME_MAC,
      'cf-ipcountry': 'de',
    });
    expect(r.status).toBe(201);
    const { user, session } = await latestSession('web@example.com');
    expect(session).toMatchObject({
      userAgent: CHROME_MAC,
      clientPlatform: 'web',
      clientOs: 'macOS',
      clientBrowser: 'Chrome',
      clientAppVersion: null,
      country: 'DE',
    });
    expect(user).toMatchObject({ lastPlatform: 'web', lastCountry: 'DE', platformsSeen: ['web'] });
    expect((await sessionCreatedPayloads())[0]).toMatchObject({ platform: 'web', country: 'DE' });
  });

  it('a secret-key sign-in records the forwarded visitor User-Agent and no country', async () => {
    const r = await call('sign-up', secretKey, { email: 'server@example.com', password: PASSWORD }, {
      'user-agent': 'node',
      'x-rekey-client-user-agent': SAFARI_IPHONE,
      'cf-ipcountry': 'US',
    });
    expect(r.status).toBe(201);
    const { user, session } = await latestSession('server@example.com');
    expect(session).toMatchObject({
      userAgent: SAFARI_IPHONE,
      clientPlatform: 'web',
      clientOs: 'iOS',
      clientBrowser: 'Safari',
      country: null,
    });
    expect(user.lastCountry).toBeNull();
  });

  it('a publishable caller cannot name a User-Agent with the header', async () => {
    await call('sign-up', publicKey, { email: 'spoof@example.com', password: PASSWORD }, {
      'user-agent': FIREFOX_WINDOWS,
      'x-rekey-client-user-agent': SAFARI_IPHONE,
    });
    const { session } = await latestSession('spoof@example.com');
    expect(session).toMatchObject({ userAgent: FIREFOX_WINDOWS, clientOs: 'Windows', clientBrowser: 'Firefox' });
  });

  it('a secret-key call with no forwarded User-Agent is a server session', async () => {
    await call('sign-up', secretKey, { email: 'bare@example.com', password: PASSWORD }, { 'user-agent': 'node' });
    const { user, session } = await latestSession('bare@example.com');
    expect(session.clientPlatform).toBe('server');
    expect(user.lastPlatform).toBe('server');
  });

  it('the client hint names the platform and app version, over the User-Agent', async () => {
    const r = await call(
      'sign-up',
      secretKey,
      { email: 'app@example.com', password: PASSWORD, client: { platform: 'ios', appVersion: '4.2.0' } },
      { 'user-agent': 'MyApp/4.2.0 CFNetwork/1490 Darwin/23.5.0' },
    );
    expect(r.status).toBe(201);
    const { user, session } = await latestSession('app@example.com');
    expect(session).toMatchObject({ clientPlatform: 'ios', clientAppVersion: '4.2.0' });
    expect(user.lastPlatform).toBe('ios');
  });

  it('refuses an unknown platform in the hint', async () => {
    const r = await call('sign-up', secretKey, {
      email: 'bad@example.com',
      password: PASSWORD,
      client: { platform: 'toaster' },
    });
    expect(r.status).toBe(400);
  });

  it('a rotation carries the client fields to the new refresh row', async () => {
    const created = await call('sign-up', publicKey, { email: 'rot@example.com', password: PASSWORD }, {
      'user-agent': CHROME_MAC,
      'cf-ipcountry': 'FR',
    });
    const refreshed = await call('refresh', publicKey, { refreshToken: created.data.refreshToken }, {
      'user-agent': FIREFOX_WINDOWS,
    });
    expect(refreshed.status).toBe(200);
    const { session } = await latestSession('rot@example.com');
    expect(session.revokedAt).toBeNull();
    expect(session).toMatchObject({ clientPlatform: 'web', clientBrowser: 'Chrome', clientOs: 'macOS', country: 'FR' });
  });

  it('platformsSeen grows once per platform and a server sign-in keeps the last country', async () => {
    await call('sign-up', publicKey, { email: 'multi@example.com', password: PASSWORD }, {
      'user-agent': CHROME_MAC,
      'cf-ipcountry': 'NL',
    });
    await call('sign-in', secretKey, { email: 'multi@example.com', password: PASSWORD, client: { platform: 'android' } });
    await call('sign-in', publicKey, { email: 'multi@example.com', password: PASSWORD }, { 'user-agent': CHROME_MAC });
    const { user } = await latestSession('multi@example.com');
    expect(user.platformsSeen).toEqual(['web', 'android']);
    expect(user.lastPlatform).toBe('web');
    expect(user.lastCountry).toBe('NL');
  });

  it(`${RACERS} racing sign-ins from a new platform add it once`, async () => {
    await call('sign-up', publicKey, { email: 'race@example.com', password: PASSWORD }, { 'user-agent': CHROME_MAC });
    const results = await Promise.all(
      Array.from({ length: RACERS }, () =>
        call('sign-in', secretKey, { email: 'race@example.com', password: PASSWORD, client: { platform: 'macos' } }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const { user } = await latestSession('race@example.com');
    expect(user.platformsSeen).toEqual(['web', 'macos']);
  });

  it(`${RACERS} racing activity records of a new platform add it once`, async () => {
    await call('sign-up', publicKey, { email: 'mcp@example.com', password: PASSWORD }, { 'user-agent': CHROME_MAC });
    const { user } = await latestSession('mcp@example.com');
    await Promise.all(Array.from({ length: RACERS }, () => recordActivitySafely(user.id, 'mcp')));
    const after = await prisma.endUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.platformsSeen).toEqual(['web', 'mcp']);
  });

  it('erasure clears platform and country, and scrubs the country from session.created', async () => {
    const r = await call('sign-up', publicKey, { email: 'gone@example.com', password: PASSWORD }, {
      'user-agent': CHROME_MAC,
      'cf-ipcountry': 'SE',
    });
    const userId = (r.data.endUser as { id: string }).id;
    const erase = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${appId}/end-users/${userId}?erasure=true`,
      headers: op(),
    });
    expect(erase.statusCode).toBe(200);
    const user = await prisma.endUser.findUniqueOrThrow({ where: { id: userId } });
    expect(user).toMatchObject({ lastPlatform: null, lastCountry: null, platformsSeen: [] });
    expect(await prisma.refreshToken.count({ where: { endUserId: userId } })).toBe(0);
    expect((await sessionCreatedPayloads())[0]).toMatchObject({ country: null });
  });

  describe('country trust (TRUST_CF_IPCOUNTRY)', () => {
    it('is off by default: a CF-IPCountry through the proxy is not recorded', async () => {
      await call('sign-up', publicKey, { email: 'off@example.com', password: PASSWORD }, {
        'user-agent': CHROME_MAC,
        'cf-ipcountry': 'DE',
      }, { app: 'default' });
      const { user, session } = await latestSession('off@example.com');
      expect(session.country).toBeNull();
      expect(user.lastCountry).toBeNull();
    });

    it('ignores a forged CF-IPCountry on a direct origin hit even when trusted', async () => {
      await call('sign-up', publicKey, { email: 'forged@example.com', password: PASSWORD }, {
        'user-agent': CHROME_MAC,
        'cf-ipcountry': 'KP',
      }, { via: 'direct' });
      const { user, session } = await latestSession('forged@example.com');
      expect(session.country).toBeNull();
      expect(user.lastCountry).toBeNull();
    });
  });

  describe('the hosted portal (internal caller)', () => {
    const portal = (extra: Record<string, string> = {}) => ({
      'user-agent': PORTAL_NODE_UA,
      'x-rekey-caller-secret': CALLER_SECRET,
      'cf-ipcountry': 'US',
      ...extra,
    });

    it("records the visitor's forwarded User-Agent, and not the portal host's country", async () => {
      const r = await call('sign-up', publicKey, { email: 'portal@example.com', password: PASSWORD }, portal({
        'x-rekey-client-user-agent': SAFARI_IPHONE,
      }));
      expect(r.status).toBe(201);
      const { user, session } = await latestSession('portal@example.com');
      expect(session).toMatchObject({ userAgent: SAFARI_IPHONE, clientPlatform: 'web', clientOs: 'iOS', country: null });
      expect(user).toMatchObject({ lastPlatform: 'web', lastCountry: null });
    });

    it('records a forwarded country only when TRUST_CF_IPCOUNTRY is on', async () => {
      await call('sign-up', publicKey, { email: 'pc-on@example.com', password: PASSWORD }, portal({
        'x-rekey-client-user-agent': SAFARI_IPHONE,
        'x-rekey-client-country': 'fr',
      }));
      expect((await latestSession('pc-on@example.com')).session.country).toBe('FR');
      await call('sign-up', publicKey, { email: 'pc-off@example.com', password: PASSWORD }, portal({
        'x-rekey-client-user-agent': SAFARI_IPHONE,
        'x-rekey-client-country': 'FR',
      }), { app: 'default' });
      expect((await latestSession('pc-off@example.com')).session.country).toBeNull();
    });

    it('believes neither header without the caller secret', async () => {
      await call('sign-up', publicKey, { email: 'not-portal@example.com', password: PASSWORD }, {
        'user-agent': FIREFOX_WINDOWS,
        'x-rekey-client-user-agent': SAFARI_IPHONE,
        'x-rekey-client-country': 'FR',
      });
      const { session } = await latestSession('not-portal@example.com');
      expect(session).toMatchObject({ userAgent: FIREFOX_WINDOWS, country: null });
    });
  });

  it.each([
    ['spaces', '4.2 beta'],
    ['markup', '<b>1</b>'],
    ['too long', '1'.repeat(33)],
  ])('refuses an app version with %s', async (_name, appVersion) => {
    const r = await call('sign-up', secretKey, {
      email: `v-${Math.random().toString(36).slice(2, 7)}@example.com`,
      password: PASSWORD,
      client: { platform: 'ios', appVersion },
    });
    expect(r.status).toBe(400);
  });

  it('accepts a semver-style app version', async () => {
    const r = await call('sign-up', secretKey, {
      email: 'semver@example.com',
      password: PASSWORD,
      client: { platform: 'android', appVersion: '4.2.0-beta.1+build_7' },
    });
    expect(r.status).toBe(201);
  });

  it('the DSAR export carries the roll-up and each session client', async () => {
    const r = await call('sign-up', publicKey, { email: 'dsar@example.com', password: PASSWORD }, {
      'user-agent': CHROME_MAC,
      'cf-ipcountry': 'IT',
    });
    const userId = (r.data.endUser as { id: string }).id;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appId}/end-users/${userId}/export`,
      headers: op(),
    });
    expect(res.statusCode).toBe(200);
    const doc = JSON.parse(res.body) as { endUser: Json; sessions: Json[] };
    expect(doc.endUser).toMatchObject({
      lastPlatform: 'web',
      platformsSeen: ['web'],
      lastCountry: 'IT',
      signInCount: 1,
      lastSignInVia: 'password',
    });
    expect(doc.sessions[0]).toMatchObject({ clientPlatform: 'web', clientBrowser: 'Chrome', country: 'IT' });
  });

  describe('describeClientUserAgent', () => {
    it.each([
      [CHROME_MAC, { platform: 'web', os: 'macOS', browser: 'Chrome' }],
      [SAFARI_IPHONE, { platform: 'web', os: 'iOS', browser: 'Safari' }],
      [FIREFOX_WINDOWS, { platform: 'web', os: 'Windows', browser: 'Firefox' }],
      ['okhttp/4.12.0 (Linux; Android 14)', { platform: 'android', os: 'Android', browser: null }],
      ['node', { platform: 'server', os: null, browser: null }],
      ['curl/8.4.0', { platform: 'server', os: null, browser: null }],
      ['', { platform: 'other', os: null, browser: null }],
    ])('%s', (ua, expected) => {
      expect(describeClientUserAgent(ua)).toEqual(expected);
    });
  });
});
