/**
 * Fields `@rekey.dev/shared-types` declares required, read off the wire on
 * every route that returns the type. A field a route leaves out fails here,
 * by route, instead of reaching an SDK as `undefined` behind a type that says
 * it is always there.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ApplicationDtoSchema, AuthResultDtoSchema } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY ?? '';
const APPLICATION_FIELDS = ['environment', 'supportEmail', 'reportingTimezone', 'promotedAt', 'disabledAt', 'disabledReason'] as const;
const AUTH_RESULT_FIELDS = ['deviceId', 'isNewUser'] as const;
const EXPORT_USER_FIELDS = ['bannedAt', 'profile', 'onboardingCompletedAt', 'onboardingSkippedAt', 'createdVia'] as const;

describe('required DTO fields are on the wire', () => {
  let app: FastifyInstance;
  let operatorToken: string;
  let tenantId: string;
  let applicationId: string;
  let secretKey: string;

  const call = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, token: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined && { payload: payload as never }) });

  function expectApplication(route: string, value: unknown): void {
    const row = value as Record<string, unknown>;
    for (const field of APPLICATION_FIELDS) expect(row, `${route}: ${field}`).toHaveProperty(field);
    expect(ApplicationDtoSchema.safeParse(row).success, `${route}: parses as ApplicationDto`).toBe(true);
  }

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // One test: the tables are emptied between tests, and every step below
  // reads what the steps before it wrote.
  it('ApplicationDto, AuthResultDto and the end-user export, route by route', async () => {
    const step = async (_route: string, run: () => Promise<void>): Promise<void> => run();
    const session = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: 'op-wire@example.com', password: 'pw-one-two-three', workspaceName: 'Wire' },
      })
    ).json().data as { accessToken: string; activeTenantId: string };
    operatorToken = session.accessToken;
    tenantId = session.activeTenantId;

    await step('POST /tenant/applications', async () => {
      const res = await call('POST', '/api/v1/tenant/applications/', operatorToken, { name: 'Wire app', slug: 'wire-app', enableBilling: true });
      expect(res.statusCode, res.body).toBe(201);
      expectApplication('POST /tenant/applications', res.json().data);
      applicationId = (res.json().data as { id: string }).id;
      const key = await call('POST', `/api/v1/tenant/applications/${applicationId}/api-keys`, operatorToken, { name: 'k', mode: 'live' });
      secretKey = (key.json().data as { rawKey: string }).rawKey;
    });

    await step('GET /tenant/applications, with and without the summary', async () => {
      for (const query of ['', '?include=summary']) {
        const res = await call('GET', `/api/v1/tenant/applications${query}`, operatorToken);
        expect(res.statusCode, res.body).toBe(200);
        const { items } = res.json().data as { items: unknown[] };
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) expectApplication(`GET /tenant/applications${query}`, item);
      }
    });

    await step('GET /tenant/applications/:id', async () => {
      const res = await call('GET', `/api/v1/tenant/applications/${applicationId}`, operatorToken);
      expect(res.statusCode, res.body).toBe(200);
      expectApplication('GET /tenant/applications/:id', res.json().data);
    });

    await step('promote, disable and enable', async () => {
      for (const [method, path] of [['POST', 'promote'], ['POST', 'disable'], ['DELETE', 'disable']] as const) {
        const res = await call(method, `/api/v1/tenant/applications/${applicationId}/${path}`, operatorToken, method === 'POST' ? {} : undefined);
        expect(res.statusCode, `${method} ${path}: ${res.body}`).toBe(200);
        expectApplication(`${method} /tenant/applications/:id/${path}`, res.json().data);
      }
    });

    await step('GET /tenant/operator/applications, with a personal access token', async () => {
      const minted = await call('POST', '/api/v1/tenant/auth/api-tokens', operatorToken, { name: 'agent', scopes: ['read'] });
      expect(minted.statusCode, minted.body).toBe(201);
      const res = await call('GET', '/api/v1/tenant/operator/applications', (minted.json().data as { rawToken: string }).rawToken);
      expect(res.statusCode, res.body).toBe(200);
      for (const item of (res.json().data as { items: unknown[] }).items) expectApplication('GET /tenant/operator/applications', item);
    });

    await step('the super-admin routes: create, list and read', async () => {
      const created = await call('POST', '/api/v1/admin/applications', ADMIN_KEY, { tenantId, name: 'Admin made', slug: 'admin-made' });
      expect(created.statusCode, created.body).toBe(201);
      expectApplication('POST /admin/applications', created.json().data);
      const listed = await call('GET', '/api/v1/admin/applications', ADMIN_KEY);
      expect(listed.statusCode, listed.body).toBe(200);
      for (const item of (listed.json().data as { items: unknown[] }).items) expectApplication('GET /admin/applications', item);
      const one = await call('GET', `/api/v1/admin/applications/${(created.json().data as { id: string }).id}`, ADMIN_KEY);
      expect(one.statusCode, one.body).toBe(200);
      expectApplication('GET /admin/applications/:id', one.json().data);
    });

    await step('GET /me, with a secret key', async () => {
      const res = await call('GET', '/api/v1/me', secretKey);
      expect(res.statusCode, res.body).toBe(200);
      expectApplication('GET /me', res.json().data);
    });

    await step('carries the support address an operator set, at the top level', async () => {
      const set = await call('PATCH', `/api/v1/tenant/applications/${applicationId}/email-sender`, operatorToken, { supportEmail: 'help@wire.test' });
      expect(set.statusCode, set.body).toBe(200);
      const viaTenant = (await call('GET', `/api/v1/tenant/applications/${applicationId}`, operatorToken)).json().data as { supportEmail: unknown };
      const viaKey = (await call('GET', '/api/v1/me', secretKey)).json().data as { supportEmail: unknown };
      expect([viaTenant.supportEmail, viaKey.supportEmail]).toEqual(['help@wire.test', 'help@wire.test']);
    });

    let userId = '';

    function expectAuthResult(route: string, value: unknown): void {
      const row = value as Record<string, unknown>;
      for (const field of AUTH_RESULT_FIELDS) expect(row, `${route}: ${field}`).toHaveProperty(field);
      expect(AuthResultDtoSchema.safeParse(row).success, `${route}: parses as AuthResultDto`).toBe(true);
    }

    await step('sign-up, sign-in and refresh', async () => {
      const credentials = { email: 'buyer-wire@example.com', password: 'pw-one-two-three-4' };
      const signUp = await call('POST', '/api/v1/auth/sign-up', secretKey, credentials);
      expect(signUp.statusCode, signUp.body).toBe(201);
      expectAuthResult('POST /auth/sign-up', signUp.json().data);
      expect((signUp.json().data as { isNewUser: boolean }).isNewUser).toBe(true);
      userId = (signUp.json().data as { endUser: { id: string } }).endUser.id;

      const signIn = await call('POST', '/api/v1/auth/sign-in', secretKey, credentials);
      expect(signIn.statusCode, signIn.body).toBe(200);
      expectAuthResult('POST /auth/sign-in', signIn.json().data);
      expect((signIn.json().data as { isNewUser: boolean }).isNewUser).toBe(false);
      const { refreshToken } = signIn.json().data as { refreshToken: string };

      const refreshed = await call('POST', '/api/v1/auth/refresh', secretKey, { refreshToken });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expectAuthResult('POST /auth/refresh', refreshed.json().data);
    });

    await step('the export names every user field, the support cases and the contacts, for a user who has none', async () => {
      const res = await call('GET', `/api/v1/tenant/applications/${applicationId}/end-users/${userId}/export`, operatorToken);
      expect(res.statusCode, res.body).toBe(200);
      const document = res.json() as { endUser: Record<string, unknown>; supportCases: unknown; contacts: unknown };
      for (const field of EXPORT_USER_FIELDS) expect(document.endUser, field).toHaveProperty(field);
      expect(document.supportCases).toEqual([]);
      expect(document.contacts).toEqual([]);
    });

    // What the panel reads without a guard, on the operator routes it reads it from.
    const read = async (path: string): Promise<Record<string, unknown>> => {
      const res = await call('GET', `/api/v1/tenant${path}`, operatorToken);
      expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
      return res.json().data as Record<string, unknown>;
    };
    const has = (route: string, value: unknown, fields: readonly string[]): void => {
      for (const field of fields) expect(value, `${route}: ${field}`).toHaveProperty(field);
    };
    const app$ = `/applications/${applicationId}`;

    await step('GET /tenant/auth/me', async () => {
      has('GET /tenant/auth/me', await read('/auth/me'), ['emailConfirmation']);
    });
    await step('GET /tenant/workspace/limits', async () => {
      has('usage', (await read('/workspace/limits')).usage, ['contacts', 'contactLists']);
    });
    await step('GET /tenant/applications/:id', async () => {
      has('GET /tenant/applications/:id', await read(app$), ['access', 'portalBaseUrl']);
      for (const row of (await read('/applications')).items as unknown[]) has('GET /tenant/applications', row, ['access']);
    });
    await step('GET /tenant/applications/:id/stats', async () => {
      has('stats', await read(`${app$}/stats`), ['activeUsers', 'activitySeries']);
    });
    await step('the end-user list, detail and insights', async () => {
      const { items } = (await read(`${app$}/end-users`)) as { items: unknown[] };
      expect(items).toHaveLength(1);
      has('end-user list row', items[0], ['bannedAt', 'lastSignedInAt', 'lastPlatform', 'profile', 'lastActiveOn', 'lastCountry', 'onboardingStatus']);
      const detail = (await read(`${app$}/end-users/${userId}`)) as { endUser: unknown };
      has('end-user detail', detail.endUser, ['bannedAt', 'bannedBy', 'banReason']);
      const insights = (await read(`${app$}/end-users/${userId}/insights`)) as { activity: unknown; profile: unknown };
      has('insights.activity', insights.activity, ['last63']);
      has('insights.profile', insights.profile, ['onboardingSkippedAt', 'onboardingStatus']);
    });
    await step('GET /tenant/security-events', async () => {
      const { items } = (await read('/security-events')) as { items: unknown[] };
      expect(items.length).toBeGreaterThan(0);
      for (const event of items) has('security event', event, ['actorEmail']);
    });
    await step('GET /tenant/applications/:id/billing/providers', async () => {
      const { providers } = (await read(`${app$}/billing/providers`)) as { providers: Array<{ capabilities: unknown }> };
      expect(providers.length).toBeGreaterThan(0);
      for (const provider of providers) has('provider capabilities', provider.capabilities, ['checkout']);
    });
  }, 60_000);
});
