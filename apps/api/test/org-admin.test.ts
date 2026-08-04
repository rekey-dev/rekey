/**
 * Operator-side organization CRUD (Tenant · Organizations).
 *
 * Covers the admin routes the panel drives: create (with optional initial
 * OWNER), add/role/remove members, update, delete — plus the app-scoping
 * guards (foreign end-user, duplicate member).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

interface Ctx {
  appId: string;
  token: string; // operator (tenant) access token
  euA: string;
  euB: string;
}

describe('Operator organization CRUD', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function operatorToken(slug: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `op-org-${slug}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: `WS ${slug}`,
      },
    });
    return (r.json().data as { accessToken: string }).accessToken;
  }

  async function makeApp(token: string, slug: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `App ${slug}`, slug: `orgadm-${slug}` },
    });
    return (r.json().data as { id: string }).id;
  }

  async function makeEndUser(token: string, appId: string, email: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: { authorization: `Bearer ${token}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    return (r.json().data as { id: string }).id;
  }

  let ctx: Ctx;
  beforeEach(async () => {
    const token = await operatorToken(`${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    const appId = await makeApp(token, Math.random().toString(36).slice(2, 8));
    const euA = await makeEndUser(token, appId, `a-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const euB = await makeEndUser(token, appId, `b-${Math.random().toString(36).slice(2, 7)}@example.com`);
    ctx = { appId, token, euA, euB };
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${ctx.token}` });
  const orgsUrl = (): string => `/api/v1/tenant/applications/${ctx.appId}/organizations`;

  it('creates an org with an initial OWNER and lists it', async () => {
    const create = await app.inject({
      method: 'POST',
      url: orgsUrl(),
      headers: auth(),
      payload: { name: 'Acme', slug: 'acme', ownerEndUserId: ctx.euA },
    });
    expect(create.statusCode).toBe(201);
    const orgId = (create.json().data as { id: string }).id;

    const detail = await app
      .inject({ method: 'GET', url: `${orgsUrl()}/${orgId}`, headers: auth() })
      .then((r) => r.json().data as { members: Array<{ endUserId: string; role: string }> });
    expect(detail.members).toHaveLength(1);
    expect(detail.members[0]).toMatchObject({ endUserId: ctx.euA, role: 'OWNER' });

    const list = await app
      .inject({ method: 'GET', url: orgsUrl(), headers: auth() })
      .then((r) => r.json().data as { items: Array<{ id: string; memberCount: number }> });
    expect(list.items.find((o) => o.id === orgId)?.memberCount).toBe(1);
  });

  it('add member → set role → remove member', async () => {
    const orgId = await app
      .inject({ method: 'POST', url: orgsUrl(), headers: auth(), payload: { name: 'T', slug: 'team-x' } })
      .then((r) => r.json().data as { id: string })
      .then((d) => d.id);

    const add = await app.inject({
      method: 'POST',
      url: `${orgsUrl()}/${orgId}/members`,
      headers: auth(),
      payload: { endUserId: ctx.euA, role: 'MEMBER' },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json().data).toMatchObject({ endUserId: ctx.euA, role: 'MEMBER' });

    const promote = await app.inject({
      method: 'PATCH',
      url: `${orgsUrl()}/${orgId}/members/${ctx.euA}`,
      headers: auth(),
      payload: { role: 'ADMIN' },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().data.role).toBe('ADMIN');

    const remove = await app.inject({
      method: 'DELETE',
      url: `${orgsUrl()}/${orgId}/members/${ctx.euA}`,
      headers: auth(),
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json().data).toEqual({ removed: true });

    const after = await prisma.organizationMembership.count({ where: { organizationId: orgId } });
    expect(after).toBe(0);
  });

  it('rejects a duplicate member (409) and a foreign end-user (404)', async () => {
    const orgId = await app
      .inject({ method: 'POST', url: orgsUrl(), headers: auth(), payload: { name: 'D', slug: 'dup' } })
      .then((r) => r.json().data as { id: string })
      .then((d) => d.id);
    await app.inject({
      method: 'POST',
      url: `${orgsUrl()}/${orgId}/members`,
      headers: auth(),
      payload: { endUserId: ctx.euB, role: 'MEMBER' },
    });
    const dup = await app.inject({
      method: 'POST',
      url: `${orgsUrl()}/${orgId}/members`,
      headers: auth(),
      payload: { endUserId: ctx.euB, role: 'MEMBER' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('ORGANIZATION_ALREADY_MEMBER');

    // End-user from a different app (different operator/workspace).
    const otherToken = await operatorToken(`other-${Math.random().toString(36).slice(2, 7)}`);
    const otherApp = await makeApp(otherToken, Math.random().toString(36).slice(2, 8));
    const foreignEu = await makeEndUser(otherToken, otherApp, `x-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const foreign = await app.inject({
      method: 'POST',
      url: `${orgsUrl()}/${orgId}/members`,
      headers: auth(),
      payload: { endUserId: foreignEu, role: 'MEMBER' },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('END_USER_NOT_FOUND');
  });

  it('updates org name, then deletes it', async () => {
    const orgId = await app
      .inject({ method: 'POST', url: orgsUrl(), headers: auth(), payload: { name: 'Old', slug: 'rename-me' } })
      .then((r) => r.json().data as { id: string })
      .then((d) => d.id);

    const patch = await app.inject({
      method: 'PATCH',
      url: `${orgsUrl()}/${orgId}`,
      headers: auth(),
      payload: { name: 'New Name', metadata: { tier: 'team' } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data).toMatchObject({ name: 'New Name', slug: 'rename-me' });

    const del = await app.inject({ method: 'DELETE', url: `${orgsUrl()}/${orgId}`, headers: auth() });
    expect(del.statusCode).toBe(200);

    const gone = await app.inject({ method: 'GET', url: `${orgsUrl()}/${orgId}`, headers: auth() });
    expect(gone.statusCode).toBe(404);
  });

  it('rejects a duplicate slug (409)', async () => {
    await app.inject({ method: 'POST', url: orgsUrl(), headers: auth(), payload: { name: 'S', slug: 'taken' } });
    const dup = await app.inject({
      method: 'POST',
      url: orgsUrl(),
      headers: auth(),
      payload: { name: 'S2', slug: 'taken' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('ORGANIZATION_SLUG_TAKEN');
  });

  afterAll(async () => {
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
  });
});
