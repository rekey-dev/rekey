/**
 * Who a built-in template test send may go to.
 *
 * The test send takes an address and mails it the built-in template. On an
 * Application with no mail provider of its own that mail leaves through the
 * deployment's shared transport, under the deployment's name: an operator,
 * even one who had confirmed nothing, could have Rekey mail anyone.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();
  return {
    ...actual,
    env: { ...actual.env, RESEND_DEFAULT_API_KEY: 're_pool_shared_key', RESEND_DEFAULT_FROM: 'pool@rekey.test' },
  };
});

const h = vi.hoisted(() => ({ sends: [] as Array<{ apiKey: string; payload: { to: string; subject: string } }> }));

vi.mock('resend', () => ({
  Resend: class {
    readonly emails: { send: (payload: never) => Promise<unknown> };
    constructor(apiKey: string) {
      this.emails = {
        send: async (payload: never) => {
          h.sends.push({ apiKey, payload });
          return { data: { id: `re_msg_${h.sends.length}` }, error: null };
        },
      };
    }
  },
}));

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');

const PASSWORD = 'operator-pw-one-two-three';
const STRANGER = 'stranger@elsewhere.example';

describe('Built-in template test send', () => {
  let app: FastifyInstance;
  const previous = process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;

  beforeAll(async () => {
    process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = '1';
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    if (previous === undefined) delete process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
    else process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = previous;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  let ip = 0;
  const call = (method: 'POST' | 'PUT', url: string, payload: unknown, token?: string): Promise<LightMyRequestResponse> =>
    app.inject({
      method,
      url: `/api/v1/tenant${url}`,
      remoteAddress: `10.88.${Math.floor((ip += 1) / 250)}.${(ip % 250) + 1}`,
      ...(token && { headers: { authorization: `Bearer ${token}` } }),
      payload: payload as never,
    });

  interface World {
    token: string;
    email: string;
    userId: string;
    appId: string;
  }

  async function world(confirmed: boolean): Promise<World> {
    const tag = Math.random().toString(36).slice(2, 8);
    const email = `op-${tag}@example.com`;
    const signUp = await call('POST', '/auth/sign-up', { email, password: PASSWORD, workspaceName: `WS ${tag}` });
    expect(signUp.statusCode, signUp.body).toBe(201);
    const data = signUp.json().data as { accessToken: string; user: { id: string } };
    if (confirmed) await prisma.tenantUser.update({ where: { id: data.user.id }, data: { emailVerified: true } });
    const created = await call('POST', '/applications/', { name: 'Acme', slug: `ts-${tag}` }, data.accessToken);
    expect(created.statusCode, created.body).toBe(201);
    h.sends.length = 0;
    return { token: data.accessToken, email, userId: data.user.id, appId: (created.json().data as { id: string }).id };
  }

  const testSend = (w: World, to: string): Promise<LightMyRequestResponse> =>
    call('POST', `/applications/${w.appId}/email-templates/welcome/test-send`, { to }, w.token);

  it('an operator who has not confirmed their address cannot send one at all: 403 EMAIL_NOT_VERIFIED', async () => {
    const w = await world(false);
    for (const to of [STRANGER, w.email]) {
      const res = await testSend(w, to);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    }
    expect(h.sends).toHaveLength(0);
  });

  it('through the deployment\'s transport it goes to the operator\'s own address only: 403 EMAIL_TEST_RECIPIENT_NOT_ALLOWED otherwise', async () => {
    const w = await world(true);
    const refused = await testSend(w, STRANGER);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.code).toBe('EMAIL_TEST_RECIPIENT_NOT_ALLOWED');
    expect(String(refused.json().error.fix)).toContain(w.email);
    expect(h.sends, 'nothing left the deployment').toHaveLength(0);

    // The first remedy in the fix: your own address.
    const own = await testSend(w, w.email.toUpperCase());
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().data.kind).toBe('sent');
    expect(h.sends.map((s) => [s.apiKey, s.payload.to])).toEqual([['re_pool_shared_key', w.email.toUpperCase()]]);
  });

  it('the second remedy: with the Application\'s own mail provider connected, any address is allowed, through that provider', async () => {
    const w = await world(true);
    const connected = await call(
      'PUT',
      `/applications/${w.appId}/email-credentials`,
      { provider: 'resend', apiKey: 're_byo_own_key', fromAddress: 'hello@acme.test', fromName: 'Acme' },
      w.token,
    );
    expect(connected.statusCode, connected.body).toBe(200);
    const res = await testSend(w, STRANGER);
    expect(res.statusCode, res.body).toBe(200);
    expect(h.sends.map((s) => [s.apiKey, s.payload.to])).toEqual([['re_byo_own_key', STRANGER]]);
  });

  it('counts against the per-recipient cap: the sixth to one address in an hour is 429 AUTH_EMAIL_RECIPIENT_CAPPED', async () => {
    const w = await world(true);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await testSend(w, w.email)).statusCode);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(h.sends).toHaveLength(5);
    const refused = await testSend(w, w.email);
    expect(refused.json().error.code).toBe('AUTH_EMAIL_RECIPIENT_CAPPED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('an unconfirmed operator cannot have the deployment mail an end user either: reset and verification sends answer 403', async () => {
    const w = await world(false);
    const endUser = await prisma.endUser.create({ data: { applicationId: w.appId, email: STRANGER } });
    const routes = ['send-password-reset', 'send-verification'];
    for (const route of routes) {
      const res = await call('POST', `/applications/${w.appId}/end-users/${endUser.id}/${route}`, { reason: 'support request' }, w.token);
      expect(res.statusCode, `${route}: ${res.body}`).toBe(403);
      expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    }
    expect(h.sends).toHaveLength(0);
    await prisma.tenantUser.update({ where: { id: w.userId }, data: { emailVerified: true } });
    for (const route of routes) {
      const res = await call('POST', `/applications/${w.appId}/end-users/${endUser.id}/${route}`, { reason: 'support request' }, w.token);
      expect(res.json().error?.code, `${route}: ${res.body}`).not.toBe('EMAIL_NOT_VERIFIED');
    }
  });
});
