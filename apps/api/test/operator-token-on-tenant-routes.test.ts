/**
 * Operator personal access tokens on the tenant routes for profile fields and
 * lists: a write token sets an app up without a browser, a read token cannot
 * write even when its holder is the workspace owner, the membership still
 * bounds what a token reaches, and the list CSV export stays session-only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { generateOperatorToken } from '../src/lib/operator-token.js';
import { prisma } from '../src/lib/prisma.js';
import { contactsHarness, type ContactsWorld } from './contacts-fixtures.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const FIELDS = [{ key: 'company', label: 'Company', type: 'text', requiredForOnboarding: true }];

describe('operator personal access tokens on profile and list routes', () => {
  let app: FastifyInstance;
  const { inject, auth, world, base, createList, memberWith } = contactsHarness(() => app, '87');

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function mintPat(sessionToken: string, scopes: string[]): Promise<{ raw: string; id: string }> {
    const res = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: auth(sessionToken),
      payload: { name: 'agent', scopes },
    });
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data as { rawToken: string; apiToken: { id: string } };
    return { raw: data.rawToken, id: data.apiToken.id };
  }

  const putSchema = (w: ContactsWorld, token: string) =>
    inject({ method: 'PUT', url: `${base(w)}/profile-schema`, headers: auth(token), payload: { fields: FIELDS, version: 0 } });
  const postList = (w: ContactsWorld, token: string) =>
    inject({ method: 'POST', url: `${base(w)}/lists`, headers: auth(token), payload: { key: 'waitlist', name: 'Waitlist' } });

  it('an applications:write token sets the onboarding questions and creates a list', async () => {
    const w = await world();
    const { raw } = await mintPat(w.ownerToken, ['applications:write']);

    const schema = await putSchema(w, raw);
    expect(schema.statusCode, schema.body).toBe(200);
    expect(schema.json().data).toMatchObject({ fields: [{ key: 'company' }], version: 1 });

    const created = await postList(w, raw);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data).toMatchObject({ key: 'waitlist', name: 'Waitlist' });

    const read = await inject({ method: 'GET', url: `${base(w)}/lists`, headers: auth(raw) });
    expect(read.statusCode, read.body).toBe(200);
  });

  it('a read token held by the owner reads but cannot write', async () => {
    const w = await world();
    const { raw } = await mintPat(w.ownerToken, ['read']);

    expect((await inject({ method: 'GET', url: `${base(w)}/profile-schema`, headers: auth(raw) })).statusCode).toBe(200);
    expect((await inject({ method: 'GET', url: `${base(w)}/lists`, headers: auth(raw) })).statusCode).toBe(200);

    for (const res of [await putSchema(w, raw), await postList(w, raw)]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('OPERATOR_SCOPE_INSUFFICIENT');
    }
  });

  it('a session still reaches the same routes', async () => {
    const w = await world();
    expect((await putSchema(w, w.ownerToken)).statusCode).toBe(200);
    expect((await postList(w, w.ownerToken)).statusCode).toBe(201);
  });

  it("a token cannot reach past its holder's grant", async () => {
    const w = await world();
    await memberWith(w, 'APP_VIEWER');
    // A MEMBER cannot mint a token today; this one stands for a token minted
    // while its holder was an ADMIN, before a demotion.
    const member = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: w.tenantId, role: 'MEMBER' } });
    const { raw, hash, prefix } = generateOperatorToken();
    await prisma.tenantApiToken.create({
      data: { tenantUserId: member.tenantUserId, tenantId: w.tenantId, name: 'old', tokenPrefix: prefix, tokenHash: hash, scopes: ['read', 'applications:write'] },
    });

    const write = await postList(w, raw);
    expect(write.statusCode, write.body).toBe(403);
    expect(write.json().error.code).toBe('APP_ACCESS_DENIED');

    expect((await inject({ method: 'GET', url: `${base(w)}/profile-schema`, headers: auth(raw) })).statusCode).toBe(200);
    const lists = await inject({ method: 'GET', url: `${base(w)}/lists`, headers: auth(raw) });
    expect(lists.statusCode, lists.body).toBe(403);
    expect(lists.json().error.code).toBe('SCOPE_INSUFFICIENT');
  });

  it('a revoked token is refused', async () => {
    const w = await world();
    const { raw, id } = await mintPat(w.ownerToken, ['applications:write']);
    const revoked = await inject({ method: 'DELETE', url: `/api/v1/tenant/auth/api-tokens/${id}`, headers: auth(w.ownerToken) });
    expect(revoked.statusCode, revoked.body).toBeLessThan(300);

    const res = await postList(w, raw);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('OPERATOR_TOKEN_INVALID');
  });

  it('the list CSV export refuses a token and serves a session', async () => {
    const w = await world();
    const listId = (((await createList(w)).json().data) as { id: string }).id;
    const { raw } = await mintPat(w.ownerToken, ['applications:write']);
    const url = `${base(w)}/lists/${listId}/export.csv`;

    const byToken = await inject({ method: 'GET', url, headers: auth(raw) });
    expect(byToken.statusCode, byToken.body).toBe(403);
    expect(byToken.json().error.code).toBe('OPERATOR_TOKEN_NOT_ACCEPTED');

    expect((await inject({ method: 'GET', url, headers: auth(w.ownerToken) })).statusCode).toBe(200);
  });
});
