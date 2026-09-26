/**
 * Auth and user lifecycle webhooks are written in the transaction of the change
 * they announce.
 *
 * They used to be enqueued by a detached `emit` after the change committed, so a
 * crash or a pool timeout between the two lost the event with no row left for
 * the poller to find. What is asserted here is the database outcome, never a
 * mock of the webhook service:
 *
 *   - the delivery row exists the moment the request returns, with the payload
 *     consumers already depend on;
 *   - the change and its event are one unit: when either cannot be written,
 *     neither is.
 *
 * Failures are injected with Postgres triggers rather than by stubbing the code
 * under test, so the statements that run are the ones production runs. The
 * endpoint URL is unreachable on purpose; delivery is webhooks.test.ts's
 * business.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';

describe('Auth lifecycle webhooks are transactional', () => {
  let app: FastifyInstance;
  let operator: string;
  let appId: string;
  let secretKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
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
        payload: { email: `lo-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: op(),
        payload: { name: 'LO', slug: `lo-${slug}` },
      })
      .then((r) => (r.json().data as { id: string }).id);
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: op(),
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await webhookService.createEndpoint({
      applicationId: appId,
      url: 'https://example.invalid/lifecycle-hook',
      events: ['*'],
    });
  });

  // Triggers are DDL and survive TRUNCATE, so every one a test installs is
  // dropped here whether the test passed or not.
  afterEach(async () => {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS lo_fail_delivery ON webhook_deliveries');
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS lo_fail_commit ON end_users');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS lo_raise()');
  });

  async function deliveries(type: string): Promise<Array<{ payload: { type: string; data: unknown } }>> {
    const rows = await prisma.webhookDelivery.findMany({
      where: { applicationId: appId, eventType: type },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ payload: r.payload as { type: string; data: unknown } }));
  }

  async function signUp(email: string): Promise<{ status: number; accessToken?: string; userId?: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: sk(),
      payload: { email, password: 'pw-one-two-three' },
    });
    if (res.statusCode !== 201 && res.statusCode !== 200) return { status: res.statusCode };
    const data = res.json().data as { accessToken: string; endUser: { id: string } };
    return { status: res.statusCode, accessToken: data.accessToken, userId: data.endUser.id };
  }

  async function installRaise(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION lo_raise() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END;
      $$ LANGUAGE plpgsql`);
  }

  it('user.created is on disk when sign-up returns, with the payload consumers read', async () => {
    const r = await signUp('first@example.com');
    expect(r.status).toBe(201);

    // No waiting and no polling: the row committed with the user.
    const rows = await deliveries('user.created');
    expect(rows).toHaveLength(1);
    const user = await prisma.endUser.findUniqueOrThrow({ where: { id: r.userId! } });
    expect(rows[0]!.payload.data).toEqual({
      user: {
        id: user.id,
        email: 'first@example.com',
        emailVerified: false,
        role: user.role,
        createdAt: user.createdAt.toISOString(),
        metadata: null,
      },
    });
  });

  it('a sign-up whose event cannot be written creates no user', async () => {
    // The delivery insert fails inside the sign-up's transaction. Enqueued
    // after the commit, as it used to be, the user would exist with no event
    // and the request would still answer 201.
    await installRaise();
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER lo_fail_delivery BEFORE INSERT ON webhook_deliveries
      FOR EACH ROW WHEN (NEW.event_type = 'user.created') EXECUTE FUNCTION lo_raise()`);

    const r = await signUp('orphan@example.com');
    expect(r.status).toBe(500);
    expect(
      await prisma.endUser.count({ where: { applicationId: appId, email: 'orphan@example.com' } }),
    ).toBe(0);
    expect(await deliveries('user.created')).toHaveLength(0);
  });

  it('a sign-up that fails at COMMIT leaves no user.created behind', async () => {
    // Deferred to COMMIT, i.e. after the delivery row was inserted in the same
    // transaction: the row must go with the user it announced.
    await installRaise();
    await prisma.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER lo_fail_commit AFTER INSERT ON end_users
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW WHEN (NEW.email = 'late@example.com') EXECUTE FUNCTION lo_raise()`);

    const r = await signUp('late@example.com');
    expect(r.status).toBe(500);
    expect(
      await prisma.endUser.count({ where: { applicationId: appId, email: 'late@example.com' } }),
    ).toBe(0);
    expect(await deliveries('user.created')).toHaveLength(0);
  });

  it('a duplicate sign-up announces nothing', async () => {
    expect((await signUp('dup@example.com')).status).toBe(201);
    expect((await signUp('dup@example.com')).status).toBe(409);
    expect(await deliveries('user.created')).toHaveLength(1);
  });

  it('password.changed, email.verified and session.revoked commit with their change, payloads unchanged', async () => {
    const r = await signUp('flow@example.com');
    const userHeaders = { ...sk(), 'x-rekey-user-token': r.accessToken! };

    // email.verified
    const send = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/send-verification',
      headers: userHeaders,
      payload: {},
    });
    const token = (send.json().data as { verificationToken: string }).verificationToken;
    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: sk(),
      payload: { token },
    });
    expect(verify.statusCode).toBe(200);
    expect((await deliveries('email.verified')).map((d) => d.payload.data)).toEqual([
      { userId: r.userId, email: 'flow@example.com' },
    ]);

    // session.revoked, before the password change revokes every session.
    const sessions = await app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: userHeaders });
    const body = sessions.json() as { data: Array<{ id: string }> | { items: Array<{ id: string }> } };
    const list = Array.isArray(body.data) ? body.data : body.data.items;
    const sessionId = list[0]!.id;
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${sessionId}`,
      headers: userHeaders,
    });
    expect((revoke.json().data as { revoked: boolean }).revoked).toBe(true);
    // Idempotent repeat: nothing revoked, nothing announced.
    await app.inject({ method: 'DELETE', url: `/api/v1/auth/sessions/${sessionId}`, headers: userHeaders });
    expect((await deliveries('session.revoked')).map((d) => d.payload.data)).toEqual([
      { userId: r.userId, sessionId, via: 'self' },
    ]);

    // password.changed, via change. A fresh session: the revoke above ended
    // the one sign-up issued.
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: sk(),
      payload: { email: 'flow@example.com', password: 'pw-one-two-three' },
    });
    const fresh = (signIn.json().data as { accessToken: string }).accessToken;
    const change = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { ...sk(), 'x-rekey-user-token': fresh },
      payload: { currentPassword: 'pw-one-two-three', newPassword: 'pw-four-five-six' },
    });
    expect(change.statusCode).toBe(200);
    expect((await deliveries('password.changed')).map((d) => d.payload.data)).toEqual([
      { userId: r.userId, email: 'flow@example.com', via: 'change' },
    ]);
  });

  it('a password change whose event cannot be written keeps the old password', async () => {
    const r = await signUp('keep@example.com');
    const before = await prisma.endUser.findUniqueOrThrow({ where: { id: r.userId! } });
    await installRaise();
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER lo_fail_delivery BEFORE INSERT ON webhook_deliveries
      FOR EACH ROW WHEN (NEW.event_type = 'password.changed') EXECUTE FUNCTION lo_raise()`);

    const change = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { ...sk(), 'x-rekey-user-token': r.accessToken! },
      payload: { currentPassword: 'pw-one-two-three', newPassword: 'pw-four-five-six' },
    });
    expect(change.statusCode).toBe(500);
    const after = await prisma.endUser.findUniqueOrThrow({ where: { id: r.userId! } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await deliveries('password.changed')).toHaveLength(0);
  });

  it('user.deleted and user.erased commit with the delete and the erasure', async () => {
    const gone = await signUp('gone@example.com');
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${appId}/end-users/${gone.userId}`,
      headers: op(),
    });
    expect(del.statusCode).toBe(200);
    expect((await deliveries('user.deleted')).map((d) => d.payload.data)).toEqual([
      { user: { id: gone.userId } },
    ]);

    const erased = await signUp('erased@example.com');
    const erase = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${appId}/end-users/${erased.userId}?erasure=true`,
      headers: op(),
    });
    expect(erase.statusCode).toBe(200);
    const erasedAt = (erase.json().data as { erasedAt: string }).erasedAt;
    expect((await deliveries('user.erased')).map((d) => d.payload.data)).toEqual([
      { user: { id: erased.userId, erasedAt } },
    ]);
    // The erasure's own scrub ran before the event was written, so the event
    // is not rewritten by it; and a repeat erasure is a no-op that announces
    // nothing.
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${appId}/end-users/${erased.userId}?erasure=true`,
      headers: op(),
    });
    expect(await deliveries('user.erased')).toHaveLength(1);
  });
});
