/**
 * Per-Application end-user role catalog —
 * `/api/v1/tenant/applications/:id/end-user-roles`.
 *
 * A per-app RBAC surface with four operations and, until now, no test. It is
 * the thing `EndUser.role` validates against, so its failure modes are not
 * cosmetic: deleting the default role would leave public sign-ups with nothing
 * to assign, and deleting a role still in use would strand users on a name the
 * catalog no longer knows.
 *
 * Every refusal in `end-user-roles.service.ts` is asserted here; none of those
 * codes appeared in any test before.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

interface Fixture {
  accessToken: string;
  applicationId: string;
  liveKey: string;
}

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('end-user role catalog', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function rand(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  async function bootstrap(): Promise<Fixture> {
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `roles-${rand()}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: 'Roles Co',
      },
    });
    expect(signUp.statusCode).toBe(201);
    const accessToken = (signUp.json().data as { accessToken: string }).accessToken;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: 'Roles app', slug: `roles-${rand()}` },
    });
    expect(created.statusCode).toBe(201);
    const applicationId = (created.json().data as { id: string }).id;

    const key = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/api-keys`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name: 'k', mode: 'live' },
    });
    expect(key.statusCode).toBe(201);

    return {
      accessToken,
      applicationId,
      liveKey: (key.json().data as { rawKey: string }).rawKey,
    };
  }

  function url(f: Fixture, suffix = ''): string {
    return `/api/v1/tenant/applications/${f.applicationId}/end-user-roles${suffix}`;
  }

  function list(f: Fixture): ReturnType<typeof app.inject> {
    return app.inject({
      method: 'GET',
      url: url(f),
      headers: { authorization: `Bearer ${f.accessToken}` },
    });
  }

  function create(f: Fixture, payload: Record<string, unknown>): ReturnType<typeof app.inject> {
    return app.inject({
      method: 'POST',
      url: url(f),
      headers: { authorization: `Bearer ${f.accessToken}` },
      payload,
    });
  }

  // ---------- list + bootstrap ----------

  it('a new Application is seeded with exactly one default role: user', async () => {
    const f = await bootstrap();
    const res = await list(f);
    expect(res.statusCode).toBe(200);
    const roles = res.json().data as Array<{ name: string; isDefault: boolean }>;
    expect(roles).toHaveLength(1);
    expect(roles[0]!.name).toBe('user');
    expect(roles[0]!.isDefault).toBe(true);
  });

  it('the catalog is scoped to one Application, not shared across a workspace', async () => {
    const f = await bootstrap();
    await create(f, { name: 'editor' });

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${f.accessToken}` },
      payload: { name: 'Second', slug: `roles-2-${rand()}` },
    });
    const secondId = (second.json().data as { id: string }).id;

    const other = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${secondId}/end-user-roles`,
      headers: { authorization: `Bearer ${f.accessToken}` },
    });
    const names = (other.json().data as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(['user']);
  });

  // ---------- create ----------

  it('creates a role, and marking it default demotes the previous one', async () => {
    const f = await bootstrap();
    const res = await create(f, { name: 'admin', description: 'Ops', isDefault: true });
    expect(res.statusCode).toBe(201);
    expect((res.json().data as { isDefault: boolean }).isDefault).toBe(true);

    const roles = (await list(f)).json().data as Array<{ name: string; isDefault: boolean }>;
    // Exactly one default, always.
    expect(roles.filter((r) => r.isDefault)).toHaveLength(1);
    expect(roles.find((r) => r.isDefault)!.name).toBe('admin');
    expect(roles.find((r) => r.name === 'user')!.isDefault).toBe(false);
  });

  // Two validators guard the name: the route's JSON schema (length) runs
  // first, the service's slug regex (character set + edges) second. Both
  // refuse with 400; the codes differ, and pinning which is which is how a
  // regression in either one shows up as a failure rather than a shrug.
  it.each([
    ['Admin', 'END_USER_ROLE_NAME_INVALID'],
    ['has space', 'END_USER_ROLE_NAME_INVALID'],
    ['-leading', 'END_USER_ROLE_NAME_INVALID'],
    ['trailing-', 'END_USER_ROLE_NAME_INVALID'],
    ['a', 'BAD_REQUEST'],
    ['x'.repeat(41), 'BAD_REQUEST'],
  ])('rejects the role name %j', async (name, code) => {
    const f = await bootstrap();
    const res = await create(f, { name });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
    // Nothing was written on the way to the refusal.
    const names = ((await list(f)).json().data as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(['user']);
  });

  it('rejects a duplicate name with END_USER_ROLE_NAME_TAKEN', async () => {
    const f = await bootstrap();
    expect((await create(f, { name: 'editor' })).statusCode).toBe(201);
    const dup = await create(f, { name: 'editor' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('END_USER_ROLE_NAME_TAKEN');
  });

  // ---------- update ----------

  it('updates the description and can move the default flag', async () => {
    const f = await bootstrap();
    await create(f, { name: 'editor' });

    const res = await app.inject({
      method: 'PATCH',
      url: url(f, '/editor'),
      headers: { authorization: `Bearer ${f.accessToken}` },
      payload: { description: 'Can edit', isDefault: true },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json().data as { description: string; isDefault: boolean };
    expect(updated.description).toBe('Can edit');
    expect(updated.isDefault).toBe(true);

    const roles = (await list(f)).json().data as Array<{ isDefault: boolean }>;
    expect(roles.filter((r) => r.isDefault)).toHaveLength(1);
  });

  it('updating an unknown role is END_USER_ROLE_NOT_FOUND', async () => {
    const f = await bootstrap();
    const res = await app.inject({
      method: 'PATCH',
      url: url(f, '/ghost'),
      headers: { authorization: `Bearer ${f.accessToken}` },
      payload: { description: 'nope' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('END_USER_ROLE_NOT_FOUND');
  });

  // ---------- delete ----------

  it('deletes an unused, non-default role', async () => {
    const f = await bootstrap();
    await create(f, { name: 'editor' });

    const res = await app.inject({
      method: 'DELETE',
      url: url(f, '/editor'),
      headers: { authorization: `Bearer ${f.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ removed: true, reassigned: 0 });

    const names = ((await list(f)).json().data as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(['user']);
  });

  it('refuses to delete the default role — sign-ups would have nothing to assign', async () => {
    const f = await bootstrap();
    const res = await app.inject({
      method: 'DELETE',
      url: url(f, '/user'),
      headers: { authorization: `Bearer ${f.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('END_USER_ROLE_IS_DEFAULT');

    // Still there — the refusal is not cosmetic.
    const names = ((await list(f)).json().data as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('user');
  });

  it('refuses to delete a role end-users still hold, unless reassignTo is given', async () => {
    const f = await bootstrap();
    await create(f, { name: 'editor' });
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${f.liveKey}` },
      payload: { email: `holder-${rand()}@example.com`, password: 'pw-one-two-three' },
    });
    expect(signUp.statusCode).toBe(201);
    const endUserId = (signUp.json().data as { endUser: { id: string } }).endUser.id;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${f.applicationId}/end-users/${endUserId}`,
      headers: { authorization: `Bearer ${f.accessToken}` },
      payload: { role: 'editor' },
    });

    const blocked = await app.inject({
      method: 'DELETE',
      url: url(f, '/editor'),
      headers: { authorization: `Bearer ${f.accessToken}` },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe('END_USER_ROLE_IN_USE');
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: endUserId } })).role).toBe(
      'editor',
    );

    // With a reassignment target it deletes and bulk-moves atomically.
    const ok = await app.inject({
      method: 'DELETE',
      url: url(f, '/editor?reassignTo=user'),
      headers: { authorization: `Bearer ${f.accessToken}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual({ removed: true, reassigned: 1 });
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: endUserId } })).role).toBe('user');
    const names = ((await list(f)).json().data as Array<{ name: string }>).map((r) => r.name);
    expect(names).not.toContain('editor');
  });

  it('reassignTo must be a different, existing role', async () => {
    const f = await bootstrap();
    await create(f, { name: 'editor' });

    const self = await app.inject({
      method: 'DELETE',
      url: url(f, '/editor?reassignTo=editor'),
      headers: { authorization: `Bearer ${f.accessToken}` },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().error.code).toBe('END_USER_ROLE_REASSIGN_SELF');

    const ghost = await app.inject({
      method: 'DELETE',
      url: url(f, '/editor?reassignTo=nonexistent'),
      headers: { authorization: `Bearer ${f.accessToken}` },
    });
    expect(ghost.statusCode).toBe(400);
    expect(ghost.json().error.code).toBe('END_USER_ROLE_REASSIGN_TARGET_UNKNOWN');

    // Neither refusal deleted anything.
    const names = ((await list(f)).json().data as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('editor');
  });

  it('deleting an unknown role is END_USER_ROLE_NOT_FOUND', async () => {
    const f = await bootstrap();
    const res = await app.inject({
      method: 'DELETE',
      url: url(f, '/ghost'),
      headers: { authorization: `Bearer ${f.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('END_USER_ROLE_NOT_FOUND');
  });

  // ---------- the catalog is authoritative ----------

  it('assigning an end-user a role outside the catalog is END_USER_ROLE_UNKNOWN', async () => {
    const f = await bootstrap();
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${f.liveKey}` },
      payload: { email: `catalog-${rand()}@example.com`, password: 'pw-one-two-three' },
    });
    const endUserId = (signUp.json().data as { endUser: { id: string } }).endUser.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${f.applicationId}/end-users/${endUserId}`,
      headers: { authorization: `Bearer ${f.accessToken}` },
      payload: { role: 'not-in-the-catalog' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('END_USER_ROLE_UNKNOWN');
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: endUserId } })).role).toBe('user');
  });

  it('public sign-up gets the default role, whichever role that currently is', async () => {
    const f = await bootstrap();
    await create(f, { name: 'guest', isDefault: true });

    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${f.liveKey}` },
      payload: { email: `default-${rand()}@example.com`, password: 'pw-one-two-three' },
    });
    expect(signUp.statusCode).toBe(201);
    const endUserId = (signUp.json().data as { endUser: { id: string } }).endUser.id;
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: endUserId } })).role).toBe(
      'guest',
    );
  });
});
