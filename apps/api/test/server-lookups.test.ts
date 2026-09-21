/**
 * Secret-key server reads. A backend that holds a secret key but no user
 * token can answer "who is this id / email" and "what is this user entitled
 * to". Both refuse the publishable key, both are scoped to the calling
 * Application, and both 404 across it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const PASSWORD = 'pw-one-two-three';

describe('secret-key end-user lookup and entitlements', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let liveKey: string;
  let pubKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });
  const secret = (): { authorization: string } => ({ authorization: `Bearer ${liveKey}` });
  const publishable = (): { authorization: string } => ({ authorization: `Bearer ${pubKey}` });

  async function makeWorkspaceApp(tag: string): Promise<{ token: string; appId: string; liveKey: string; pubKey: string }> {
    const slug = `${tag}-${Math.random().toString(36).slice(2, 8)}`;
    const t = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const created = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${t}` },
        payload: { name: 'SL', slug, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${created.id}/api-keys`,
        headers: { authorization: `Bearer ${t}` },
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    return { token: t, appId: created.id, liveKey: key, pubKey: created.publicKey };
  }

  beforeEach(async () => {
    ({ token, appId, liveKey, pubKey } = await makeWorkspaceApp('sl'));
  });

  async function makeEndUser(applicationId: string, operatorToken: string, email: string): Promise<string> {
    return app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/end-users`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { email, password: PASSWORD },
      })
      .then((r) => (r.json().data as { id: string }).id);
  }

  it('looks up by exact email and by id, scoped to the Application, secret key only', async () => {
    const id = await makeEndUser(appId, token, 'Alice@Example.com');

    const byEmail = await app.inject({ method: 'GET', url: '/api/v1/users?email=alice@example.com', headers: secret() });
    expect(byEmail.statusCode).toBe(200);
    expect(byEmail.json().data.id).toBe(id);
    expect(byEmail.json().data).not.toHaveProperty('passwordHash');

    const byId = await app.inject({ method: 'GET', url: `/api/v1/users/${id}`, headers: secret() });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().data.email).toBe('alice@example.com');

    // Not a substring search: a shorter, valid address is simply another address.
    const partial = await app.inject({ method: 'GET', url: '/api/v1/users?email=lice@example.com', headers: secret() });
    expect(partial.statusCode).toBe(404);
    const malformed = await app.inject({ method: 'GET', url: '/api/v1/users?email=not-an-email', headers: secret() });
    expect(malformed.statusCode).toBe(400);
    const none = await app.inject({ method: 'GET', url: '/api/v1/users?email=nobody@example.com', headers: secret() });
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe('END_USER_NOT_FOUND');

    // The publishable key cannot enumerate accounts.
    const pub = await app.inject({ method: 'GET', url: '/api/v1/users?email=alice@example.com', headers: publishable() });
    expect(pub.statusCode).toBe(401);

    // Another Application's key sees nothing.
    const other = await makeWorkspaceApp('sl2');
    const cross = await app.inject({ method: 'GET', url: `/api/v1/users/${id}`, headers: { authorization: `Bearer ${other.liveKey}` } });
    expect(cross.statusCode).toBe(404);
    const crossEmail = await app.inject({ method: 'GET', url: '/api/v1/users?email=alice@example.com', headers: { authorization: `Bearer ${other.liveKey}` } });
    expect(crossEmail.statusCode).toBe(404);

    // /users/me still resolves the token's own subject (the literal segment wins over :id).
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: publishable(),
      payload: { email: 'alice@example.com', password: PASSWORD },
    });
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { ...publishable(), 'x-rekey-user-token': signIn.json().data.accessToken },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.id).toBe(id);
  });

  it('resolves entitlements for a named end-user with a secret key, including the default plan', async () => {
    const id = await makeEndUser(appId, token, 'bob@example.com');
    // A $0 default plan granting a feature.
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/free/entitlements`,
      headers: auth(),
      payload: { kind: 'FEATURE', key: 'max_devices', valueType: 'INT', value: '2' },
    });
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    await prisma.application.update({
      where: { id: appId },
      data: { billingConfig: { ...(application.billingConfig as object), defaultPlanSlug: 'free' } as never },
    });

    const res = await app.inject({ method: 'GET', url: `/api/v1/billing/entitlements/for-user?endUserId=${id}`, headers: secret() });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.features.max_devices).toBe(2);
    expect(res.json().data).toHaveProperty('creditBalance');

    const pub = await app.inject({ method: 'GET', url: `/api/v1/billing/entitlements/for-user?endUserId=${id}`, headers: publishable() });
    expect(pub.statusCode).toBe(401);

    const unknown = await app.inject({ method: 'GET', url: '/api/v1/billing/entitlements/for-user?endUserId=nope', headers: secret() });
    expect(unknown.statusCode).toBe(404);

    const missing = await app.inject({ method: 'GET', url: '/api/v1/billing/entitlements/for-user', headers: secret() });
    expect(missing.statusCode).toBe(400);

    // Cross-application id is a 404, not another tenant's data.
    const other = await makeWorkspaceApp('sl3');
    const cross = await app.inject({ method: 'GET', url: `/api/v1/billing/entitlements/for-user?endUserId=${id}`, headers: { authorization: `Bearer ${other.liveKey}` } });
    expect(cross.statusCode).toBe(404);
  });
});
