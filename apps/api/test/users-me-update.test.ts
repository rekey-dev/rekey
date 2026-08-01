/**
 * PATCH /api/v1/users/me — end-user self-service metadata writes.
 *
 * Two properties carry the weight here:
 *
 *   1. **Merge, not replace.** The route promises a top-level shallow merge.
 *      If that ever silently flips to wholesale replace, every integrator doing
 *      read-edit-write loses the keys they did not resend — a data-loss bug
 *      that no type checker catches, so it is asserted directly.
 *   2. **The token is the only subject.** There is no user id in the path or
 *      the body, and neither a body field nor a foreign token may redirect the
 *      write at another row.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface BootstrappedApp {
  applicationId: string;
  liveKey: string;
}

interface SignedUpUser {
  id: string;
  accessToken: string;
}

describe('PATCH /api/v1/users/me — self-service metadata', () => {
  let app: FastifyInstance;
  let appA: BootstrappedApp;
  let appB: BootstrappedApp;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrapApplication(slug: string): Promise<BootstrappedApp> {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: `T-${slug}`, ownerEmail: `t-${slug}@example.com` },
      })
      .then((r) => r.json().data as { id: string });

    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: slug, slug },
      })
      .then((r) => r.json().data as { id: string });

    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => r.json().data as { rawKey: string });

    return { applicationId: application.id, liveKey: key.rawKey };
  }

  async function signUp(
    target: BootstrappedApp,
    email: string,
    metadata?: Record<string, unknown>,
  ): Promise<SignedUpUser> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${target.liveKey}` },
      payload: {
        email,
        password: 'pw-one-two-three',
        ...(metadata !== undefined && { metadata }),
      },
    });
    const data = res.json().data as { accessToken: string; endUser: { id: string } };
    return { id: data.endUser.id, accessToken: data.accessToken };
  }

  function patch(target: BootstrappedApp, accessToken: string, payload: unknown) {
    return app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/',
      headers: {
        authorization: `Bearer ${target.liveKey}`,
        'x-rekey-user-token': accessToken,
      },
      payload: payload as Record<string, unknown>,
    });
  }

  async function storedMetadata(endUserId: string): Promise<unknown> {
    const row = await prisma.endUser.findUnique({ where: { id: endUserId } });
    return row?.metadata ?? null;
  }

  beforeEach(async () => {
    appA = await bootstrapApplication('patch-app-a');
    appB = await bootstrapApplication('patch-app-b');
  });

  // ---------- happy path ----------

  it('writes metadata for the calling user and returns the updated record', async () => {
    const user = await signUp(appA, 'alice@example.com');

    const res = await patch(appA, user.accessToken, {
      metadata: { displayName: 'Alice', theme: 'dark' },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json().data as { id: string; metadata: Record<string, unknown> };
    expect(data.id).toBe(user.id);
    expect(data.metadata).toEqual({ displayName: 'Alice', theme: 'dark' });
    expect(res.json().data).not.toHaveProperty('passwordHash');
    await expect(storedMetadata(user.id)).resolves.toEqual({
      displayName: 'Alice',
      theme: 'dark',
    });
  });

  it('is readable back through GET /users/me', async () => {
    const user = await signUp(appA, 'alice-read@example.com');
    await patch(appA, user.accessToken, { metadata: { plan: 'pro' } });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: {
        authorization: `Bearer ${appA.liveKey}`,
        'x-rekey-user-token': user.accessToken,
      },
    });
    expect(res.json().data.metadata).toEqual({ plan: 'pro' });
  });

  // ---------- merge semantics ----------

  it('MERGE: an omitted key survives, a sent key replaces it, and a null key is deleted', async () => {
    const user = await signUp(appA, 'merge@example.com', {
      keep: 'untouched',
      overwrite: 'before',
      remove: 'goodbye',
    });

    const res = await patch(appA, user.accessToken, {
      metadata: { overwrite: 'after', remove: null, added: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.metadata).toEqual({
      keep: 'untouched',
      overwrite: 'after',
      added: true,
    });
  });

  it('MERGE is shallow: a nested object replaces wholesale, it is not deep-merged', async () => {
    const user = await signUp(appA, 'shallow@example.com', {
      prefs: { theme: 'dark', locale: 'en' },
    });

    const res = await patch(appA, user.accessToken, { metadata: { prefs: { theme: 'light' } } });

    // `locale` is gone — the route documents wholesale top-level replacement,
    // and pretending otherwise (deep merge) is the surprise that makes nested
    // deletes impossible.
    expect(res.json().data.metadata).toEqual({ prefs: { theme: 'light' } });
  });

  it('omitting metadata entirely is a no-op, not a wipe', async () => {
    const user = await signUp(appA, 'noop@example.com', { keep: 'me' });

    const res = await patch(appA, user.accessToken, {});

    expect(res.statusCode).toBe(200);
    expect(res.json().data.metadata).toEqual({ keep: 'me' });
  });

  it('metadata: null clears the whole object', async () => {
    const user = await signUp(appA, 'clear@example.com', { a: 1, b: 2 });

    const res = await patch(appA, user.accessToken, { metadata: null });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.metadata).toBeNull();
    await expect(storedMetadata(user.id)).resolves.toBeNull();
  });

  // ---------- allowlist ----------

  it('REFUSES (does not ignore) a privilege-bearing field: role stays untouched', async () => {
    const user = await signUp(appA, 'escalate@example.com');

    const res = await patch(appA, user.accessToken, { role: 'admin' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('END_USER_UPDATE_INVALID');
    const row = await prisma.endUser.findUnique({ where: { id: user.id } });
    expect(row?.role).toBe('user');
  });

  it('REFUSES an email change and an erasure stamp on this route', async () => {
    const user = await signUp(appA, 'identity@example.com');

    for (const body of [
      { email: 'someone-else@example.com' },
      { erasedAt: new Date().toISOString() },
      { metadata: { ok: true }, role: 'admin' },
    ]) {
      const res = await patch(appA, user.accessToken, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('END_USER_UPDATE_INVALID');
    }

    const row = await prisma.endUser.findUnique({ where: { id: user.id } });
    expect(row?.email).toBe('identity@example.com');
    expect(row?.erasedAt).toBeNull();
    // The mixed body was rejected as a whole — no partial write.
    expect(row?.metadata).toBeNull();
  });

  // ---------- someone else's record ----------

  it("cannot touch another user's record by naming them in the body", async () => {
    const alice = await signUp(appA, 'a-owner@example.com', { owner: 'alice' });
    const bob = await signUp(appA, 'b-victim@example.com', { owner: 'bob' });

    const res = await patch(appA, alice.accessToken, {
      id: bob.id,
      endUserId: bob.id,
      metadata: { owner: 'stolen' },
    });

    // The extra ids are not on the allowlist, so the whole body is refused —
    // but the assertion that matters is that Bob is untouched either way.
    expect(res.statusCode).toBe(400);
    await expect(storedMetadata(bob.id)).resolves.toEqual({ owner: 'bob' });
    await expect(storedMetadata(alice.id)).resolves.toEqual({ owner: 'alice' });
  });

  it("a valid patch only ever hits the token's own subject", async () => {
    const alice = await signUp(appA, 'a2-owner@example.com', { owner: 'alice' });
    const bob = await signUp(appA, 'b2-victim@example.com', { owner: 'bob' });

    const res = await patch(appA, alice.accessToken, { metadata: { owner: 'alice-edited' } });

    expect(res.statusCode).toBe(200);
    await expect(storedMetadata(alice.id)).resolves.toEqual({ owner: 'alice-edited' });
    await expect(storedMetadata(bob.id)).resolves.toEqual({ owner: 'bob' });
  });

  it('CROSS-APP GUARD: a token from app A cannot write through app B\'s key', async () => {
    const alice = await signUp(appA, 'cross@example.com', { owner: 'alice' });

    const res = await patch(appB, alice.accessToken, { metadata: { owner: 'attacker' } });

    expect(res.statusCode).toBe(401);
    await expect(storedMetadata(alice.id)).resolves.toEqual({ owner: 'alice' });
  });

  it('401 USER_TOKEN_MISSING without a user token — the key alone cannot write a user', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/',
      headers: { authorization: `Bearer ${appA.liveKey}` },
      payload: { metadata: { any: 'thing' } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('USER_TOKEN_MISSING');
  });

  // ---------- size ceiling ----------

  it('rejects metadata that would exceed the 16KB ceiling after merging', async () => {
    const user = await signUp(appA, 'fat@example.com', { keep: 'me' });

    const res = await patch(appA, user.accessToken, {
      metadata: { blob: 'x'.repeat(17 * 1024) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('METADATA_TOO_LARGE');
    // Refused before the write, so the pre-existing object is intact.
    await expect(storedMetadata(user.id)).resolves.toEqual({ keep: 'me' });
  });

  // ---------- scope ----------

  it('403 for a secret key that carries auth:read but not auth:write', async () => {
    const readOnly = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${appA.applicationId}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'read-only', mode: 'live', scopes: ['auth:read'] },
      })
      .then((r) => r.json().data as { rawKey: string });

    const user = await signUp(appA, 'scoped@example.com', { keep: 'me' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/',
      headers: {
        authorization: `Bearer ${readOnly.rawKey}`,
        'x-rekey-user-token': user.accessToken,
      },
      payload: { metadata: { keep: 'changed' } },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
    await expect(storedMetadata(user.id)).resolves.toEqual({ keep: 'me' });
  });
});
