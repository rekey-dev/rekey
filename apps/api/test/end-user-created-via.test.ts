/**
 * `EndUser.createdVia`: every creation path records how the account came to
 * be, and the operator surfaces show it, with a pre-existing row read as
 * `unknown`. The billing webhook, the billing import and the user import are
 * asserted in their own suites (external-billing-webhook, subscription-import,
 * users-import).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createdViaKind, createdViaOAuth, CREATED_VIA_PATTERN } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';
import { registerOAuthProvider } from '../src/modules/oauth/providers/index.js';
import { GoogleProvider } from '../src/modules/oauth/providers/google.js';

const PASSWORD = 'pw-one-two-three';

describe('EndUser.createdVia', () => {
  let app: FastifyInstance;
  let operator: string;
  let appId: string;
  let secretKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    registerOAuthProvider(new GoogleProvider());
    await app.close();
  });

  const op = (): { authorization: string } => ({ authorization: `Bearer ${operator}` });
  const sk = (): { authorization: string } => ({ authorization: `Bearer ${secretKey}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `cv-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: op(), payload: { name: 'CV', slug: `cv-${slug}` } })
      .then((r) => (r.json().data as { id: string }).id);
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: op(),
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await applicationsService.updateAuthConfig({
      applicationId: appId,
      patch: { methods: ['password', 'magic_link', 'oauth'] },
    });
  });

  const createdVia = async (email: string): Promise<string | null> =>
    (await prisma.endUser.findFirstOrThrow({ where: { applicationId: appId, email }, select: { createdVia: true } }))
      .createdVia;

  it('password sign-up records password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: sk(),
      payload: { email: 'pw@example.com', password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    expect(await createdVia('pw@example.com')).toBe('password');
    const id = await prisma.endUser
      .findFirstOrThrow({ where: { applicationId: appId, email: 'pw@example.com' }, select: { id: true } })
      .then((u) => u.id);
    const read = await app.inject({ method: 'GET', url: `/api/v1/users/${id}`, headers: sk() });
    expect(read.json().data.createdVia).toBe('password');
  });

  it('a magic link that creates the account records magic_link', async () => {
    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      headers: sk(),
      payload: { email: 'ml-new@example.com' },
    });
    const { magicLinkToken } = requested.json().data as { magicLinkToken: string };
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      headers: sk(),
      payload: { token: magicLinkToken },
    });
    expect(verified.statusCode).toBe(200);
    expect(await createdVia('ml-new@example.com')).toBe('magic_link');
  });

  it('an OAuth-first sign-in records oauth:<provider>', async () => {
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: () => 'https://mock.example/start',
      exchange: async () => ({ providerAccountId: 'g-cv-1', email: 'oa@example.com', emailVerified: true }),
    });
    const configured = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/oauth-config/google`,
      headers: op(),
      payload: { clientId: 'gid', clientSecret: 'gsecret', redirectUri: 'https://app.example.com/oauth/google/callback' },
    });
    expect(configured.statusCode).toBe(200);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/google/callback',
      headers: sk(),
      payload: { code: 'mock-code' },
    });
    expect(res.statusCode).toBe(200);
    expect(await createdVia('oa@example.com')).toBe('oauth:google');
  });

  it('an operator-created account records operator, and the operator surfaces show it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: op(),
      payload: { email: 'op@example.com', password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json().data as { id: string }).id;
    expect(await createdVia('op@example.com')).toBe('operator');

    const detail = await app.inject({ method: 'GET', url: `/api/v1/tenant/applications/${appId}/end-users/${id}`, headers: op() });
    expect(detail.json().data.endUser.createdVia).toBe('operator');
    const insights = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appId}/end-users/${id}/insights`,
      headers: op(),
    });
    expect(insights.json().data.signIns.createdVia).toBe('operator');
    const exported = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appId}/end-users/${id}/export`,
      headers: op(),
    });
    expect(exported.json().endUser.createdVia).toBe('operator');
  });

  it('a row created before the column existed reads as unknown', async () => {
    const legacy = await prisma.endUser.create({ data: { applicationId: appId, email: 'old@example.com' } });
    const list = await app.inject({ method: 'GET', url: `/api/v1/tenant/applications/${appId}/end-users`, headers: op() });
    const row = (list.json().data.items as Array<{ id: string; createdVia: string }>).find((u) => u.id === legacy.id);
    expect(row?.createdVia).toBe('unknown');
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appId}/end-users/${legacy.id}`,
      headers: op(),
    });
    expect(detail.json().data.endUser.createdVia).toBe('unknown');
    const read = await app.inject({ method: 'GET', url: `/api/v1/users/${legacy.id}`, headers: sk() });
    expect(read.json().data.createdVia).toBe('unknown');
  });

  it('provider names are normalised to the stored pattern', () => {
    expect(createdViaOAuth('GitHub')).toBe('oauth:github');
    expect(createdViaOAuth('my.idp')).toBe('oauth:my-idp');
    expect(createdViaOAuth('')).toBe('oauth');
    for (const v of ['oauth:github', 'oauth:my-idp', 'password', 'unknown']) expect(CREATED_VIA_PATTERN.test(v)).toBe(true);
    expect(CREATED_VIA_PATTERN.test('oauth:')).toBe(false);
    expect(createdViaKind('oauth:github')).toBe('oauth');
    expect(createdViaKind(null)).toBe('unknown');
    expect(createdViaKind('nonsense')).toBe('unknown');
  });
});
