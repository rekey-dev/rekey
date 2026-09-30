/**
 * Profile fields: the Application's schema, each user's answers, who may write
 * which field, onboarding completion and its webhook, and erasure.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { missingRequired } from '../src/modules/end-users/profile-values.js';

const PASSWORD = 'pw-one-two-three';
const RACERS = 8;

type Json = Record<string, unknown>;

const SCHEMA = [
  { key: 'company', label: 'Company', type: 'text', requiredForOnboarding: true },
  { key: 'team_size', label: 'Team size', type: 'select', options: ['1', '2-10', '11+'], requiredForOnboarding: true },
  { key: 'seats', label: 'Seats', type: 'number' },
  { key: 'newsletter', label: 'Newsletter', type: 'boolean' },
  { key: 'website', label: 'Website', type: 'url' },
  { key: 'started_on', label: 'Started on', type: 'date' },
  { key: 'plan_tier', label: 'Plan tier', type: 'text', writableBy: 'server' },
];

describe('End-user profile fields', () => {
  let app: FastifyInstance;
  let operator: string;
  let appId: string;
  let secretKey: string;
  let publicKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const op = (): { authorization: string } => ({ authorization: `Bearer ${operator}` });
  const sk = (): { authorization: string } => ({ authorization: `Bearer ${secretKey}` });
  const asUser = (token: string): Record<string, string> => ({
    authorization: `Bearer ${publicKey}`,
    'x-rekey-user-token': token,
  });

  async function putSchema(fields: unknown, version?: number): Promise<{ status: number; body: Json }> {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/profile-schema`,
      headers: op(),
      payload: { fields, ...(version === undefined ? {} : { version }) },
    });
    return { status: res.statusCode, body: res.json() as Json };
  }

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: sk(),
      payload: { email, password: PASSWORD },
    });
    const data = res.json().data as { endUser: { id: string }; accessToken: string };
    return { id: data.endUser.id, token: data.accessToken };
  }

  async function patchMine(token: string, patch: Json): Promise<{ status: number; body: Json }> {
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/users/me/profile', headers: asUser(token), payload: patch });
    return { status: res.statusCode, body: res.json() as Json };
  }

  async function completeMine(token: string): Promise<{ status: number; body: Json }> {
    const res = await app.inject({ method: 'POST', url: '/api/v1/users/me/onboarding/complete', headers: asUser(token) });
    return { status: res.statusCode, body: res.json() as Json };
  }

  async function events(type: string): Promise<Json[]> {
    const rows = await prisma.webhookDelivery.findMany({
      where: { applicationId: appId, eventType: type },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => (r.payload as { data: Json }).data);
  }

  const code = (body: Json): string => (body.error as { code: string }).code;
  const details = (body: Json): Json => (body.error as { details: Json }).details;

  beforeEach(async () => {
    const slug = `pf-${Math.random().toString(36).slice(2, 8)}`;
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const created = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: op(), payload: { name: 'PF', slug } })
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
    expect((await putSchema(SCHEMA)).status).toBe(200);
  });

  describe('schema', () => {
    it.each(['constructor', 'prototype'])('refuses the reserved key "%s"', async (key) => {
      const res = await putSchema([{ key, label: 'X', type: 'text' }]);
      expect(res.status).toBe(400);
      expect(code(res.body)).toBe('PROFILE_SCHEMA_INVALID');
    });

    it('counts an inherited property name as unanswered', () => {
      const fields = [{ key: 'constructor', label: 'C', type: 'text', requiredForOnboarding: true, writableBy: 'user', showInList: false, pii: false }] as const;
      expect(missingRequired([...fields], {})).toEqual(['constructor']);
    });

    it('returns a version and refuses a PUT made against an older one', async () => {
      const read = await app.inject({ method: 'GET', url: `/api/v1/tenant/applications/${appId}/profile-schema`, headers: op() });
      const version = (read.json().data as { version: number }).version;
      expect(typeof version).toBe('number');
      const first = await putSchema(SCHEMA.map((f) => ({ ...f, label: `${f.label}!` })), version);
      expect(first.status).toBe(200);
      expect((first.body.data as { version: number }).version).toBe(version + 1);
      const stale = await putSchema(SCHEMA, version);
      expect(stale.status).toBe(409);
      expect(code(stale.body)).toBe('PROFILE_SCHEMA_CHANGED');
      expect(details(stale.body)).toEqual({ expected: version, current: version + 1 });
    });

    it('refuses removing a select option users picked, and allows removing an unused one', async () => {
      const u = await signUp('picked@example.com');
      await patchMine(u.token, { team_size: '2-10' });
      const withOptions = (options: string[]) => SCHEMA.map((f) => (f.key === 'team_size' ? { ...f, options } : f));
      const refused = await putSchema(withOptions(['1', '11+']));
      expect(refused.status).toBe(409);
      expect(code(refused.body)).toBe('PROFILE_OPTION_IN_USE');
      expect(details(refused.body).options).toEqual([{ key: 'team_size', option: '2-10', answers: 1 }]);
      expect((await putSchema(withOptions(['2-10', '11+']))).status).toBe(200);
    });

    it(`checks for answers and replaces the schema atomically against ${RACERS} racing answers`, async () => {
      const users = await Promise.all(Array.from({ length: RACERS }, (_, i) => signUp(`racer${i}@example.com`)));
      const results = await Promise.all([
        putSchema(SCHEMA.filter((f) => f.key !== 'seats')),
        ...users.map((u) => patchMine(u.token, { seats: 3 })),
      ]);
      const stored = await prisma.endUser.findMany({ where: { id: { in: users.map((u) => u.id) } } });
      const answered = stored.filter((r) => Object.hasOwn(r.profile as object, 'seats')).length;
      const app = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
      const kept = (app.profileSchema as Array<{ key: string }>).some((f) => f.key === 'seats');
      // Either the removal won and no answer to the removed field exists, or
      // answers landed first and the removal was refused. Never both.
      if (kept) expect(code(results[0]!.body)).toBe('PROFILE_FIELD_KEY_IMMUTABLE');
      else expect(answered).toBe(0);
    });

    it('stores the fields with defaults and reads them back', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/tenant/applications/${appId}/profile-schema`, headers: op() });
      const fields = (res.json().data as { fields: Json[] }).fields;
      expect(fields.map((f) => f.key)).toEqual(SCHEMA.map((f) => f.key));
      expect(fields[0]).toEqual({
        key: 'company',
        label: 'Company',
        type: 'text',
        requiredForOnboarding: true,
        writableBy: 'user',
        showInList: false,
        pii: false,
      });
    });

    it.each([
      ['a select without options', [{ key: 'a', label: 'A', type: 'select' }]],
      ['options on a text field', [{ key: 'a', label: 'A', type: 'text', options: ['x'] }]],
      ['a duplicate key', [{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'text' }]],
      ['a key with capitals', [{ key: 'Company', label: 'A', type: 'text' }]],
      ['an unknown type', [{ key: 'a', label: 'A', type: 'textarea' }]],
    ])('refuses %s with PROFILE_SCHEMA_INVALID', async (_name, fields) => {
      const res = await putSchema(fields);
      expect(res.status).toBe(400);
      expect(code(res.body)).toBe('PROFILE_SCHEMA_INVALID');
      expect((details(res.body).issues as unknown[]).length).toBeGreaterThan(0);
    });

    it('refuses removing or retyping a field that has answers, and allows relabelling', async () => {
      const u = await signUp('keys@example.com');
      expect((await patchMine(u.token, { company: 'Acme' })).status).toBe(200);

      const removed = await putSchema(SCHEMA.filter((f) => f.key !== 'company'));
      expect(removed.status).toBe(409);
      expect(code(removed.body)).toBe('PROFILE_FIELD_KEY_IMMUTABLE');
      expect(details(removed.body).fields).toEqual([{ key: 'company', answers: 1 }]);

      const retyped = await putSchema(SCHEMA.map((f) => (f.key === 'company' ? { ...f, type: 'url' } : f)));
      expect(retyped.status).toBe(409);

      expect((await putSchema(SCHEMA.map((f) => (f.key === 'company' ? { ...f, label: 'Organisation' } : f)))).status).toBe(200);
      expect((await putSchema(SCHEMA.filter((f) => f.key !== 'seats'))).status).toBe(200);
    });

    it('a publishable key sees the user-writable fields; a secret key sees all', async () => {
      const pub = await app.inject({ method: 'GET', url: '/api/v1/profile-schema', headers: { authorization: `Bearer ${publicKey}` } });
      const sec = await app.inject({ method: 'GET', url: '/api/v1/profile-schema', headers: sk() });
      const keys = (r: typeof pub) => (r.json().data as { fields: Json[] }).fields.map((f) => f.key);
      expect(keys(pub)).not.toContain('plan_tier');
      expect(keys(sec)).toContain('plan_tier');
    });
  });

  describe('answers', () => {
    it('a user sets, validates and clears their own answers, announced as user.updated', async () => {
      const u = await signUp('me@example.com');
      const set = await patchMine(u.token, {
        company: '  Acme  ',
        team_size: '2-10',
        seats: 12,
        newsletter: true,
        website: 'https://acme.example',
        started_on: '2026-02-28',
      });
      expect(set.status).toBe(200);
      expect((set.body.data as Json).profile).toEqual({
        company: 'Acme',
        team_size: '2-10',
        seats: 12,
        newsletter: true,
        website: 'https://acme.example',
        started_on: '2026-02-28',
      });
      const cleared = await patchMine(u.token, { seats: null, company: 'Acme' });
      expect((cleared.body.data as Json).profile).not.toHaveProperty('seats');

      const updates = await events('user.updated');
      expect(updates).toHaveLength(2);
      expect(updates[0]).toMatchObject({ via: 'self', changed: expect.arrayContaining(['profile.company', 'profile.team_size']) });
      expect(updates[1]!.changed).toEqual(['profile.seats']);
      expect(JSON.stringify(updates)).not.toContain('Acme');
    });

    it('a patch that changes nothing announces nothing', async () => {
      const u = await signUp('same@example.com');
      await patchMine(u.token, { company: 'Acme' });
      await patchMine(u.token, { company: 'Acme' });
      expect(await events('user.updated')).toHaveLength(1);
    });

    it('refuses a field the schema does not define', async () => {
      const u = await signUp('unknown@example.com');
      const res = await patchMine(u.token, { favourite_colour: 'blue' });
      expect(res.status).toBe(400);
      expect(code(res.body)).toBe('PROFILE_FIELD_UNKNOWN');
      expect(details(res.body).unknown).toEqual(['favourite_colour']);
    });

    it('refuses a server field from the user, and lets a secret key set it', async () => {
      const u = await signUp('server@example.com');
      const mine = await patchMine(u.token, { plan_tier: 'enterprise' });
      expect(mine.status).toBe(403);
      expect(code(mine.body)).toBe('PROFILE_FIELD_READ_ONLY');

      const server = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${u.id}/profile`,
        headers: sk(),
        payload: { plan_tier: 'enterprise' },
      });
      expect(server.statusCode).toBe(200);
      expect((server.json().data as Json).profile).toEqual({ plan_tier: 'enterprise' });
      expect((await events('user.updated')).at(-1)).toMatchObject({ via: 'server', changed: ['profile.plan_tier'] });
    });

    it.each([
      ['text', { company: '' }],
      ['text', { company: 'x'.repeat(501) }],
      ['select', { team_size: '500' }],
      ['number', { seats: '12' }],
      ['boolean', { newsletter: 'yes' }],
      ['url', { website: 'javascript:alert(1)' }],
      ['date', { started_on: '2026-02-30' }],
    ])('refuses a bad %s answer with PROFILE_FIELD_INVALID', async (_type, patch) => {
      const u = await signUp(`bad-${Math.random().toString(36).slice(2, 7)}@example.com`);
      const res = await patchMine(u.token, patch);
      expect(res.status).toBe(400);
      expect(code(res.body)).toBe('PROFILE_FIELD_INVALID');
      expect((details(res.body).issues as Json[])[0]!.key).toBe(Object.keys(patch)[0]);
    });

    it('caps the stored answers at 16 KB', async () => {
      const wide = Array.from({ length: 40 }, (_, i) => ({ key: `f${i}`, label: `F${i}`, type: 'text' }));
      expect((await putSchema(wide)).status).toBe(200);
      const u = await signUp('wide@example.com');
      const res = await patchMine(u.token, Object.fromEntries(wide.map((f) => [f.key, 'x'.repeat(500)])));
      expect(res.status).toBe(400);
      expect(code(res.body)).toBe('PROFILE_TOO_LARGE');
    });

    it(`${RACERS} concurrent patches of different fields keep every answer`, async () => {
      const wide = Array.from({ length: RACERS }, (_, i) => ({ key: `q${i}`, label: `Q${i}`, type: 'number' }));
      expect((await putSchema(wide)).status).toBe(200);
      const u = await signUp('race@example.com');
      const results = await Promise.all(wide.map((f, i) => patchMine(u.token, { [f.key]: i })));
      expect(results.every((r) => r.status === 200)).toBe(true);
      const stored = await prisma.endUser.findUniqueOrThrow({ where: { id: u.id } });
      expect(stored.profile).toEqual(Object.fromEntries(wide.map((f, i) => [f.key, i])));
    });

    it("a secret key cannot write another Application's user", async () => {
      const other = await prisma.endUser.create({
        data: {
          email: 'stranger@example.com',
          application: {
            create: {
              name: 'Other',
              slug: `other-${Math.random().toString(36).slice(2, 8)}`,
              publicKey: `rp_pub_other_${Math.random().toString(36).slice(2, 10)}`,
              authConfig: {},
              billingConfig: {},
              tenant: { create: { name: 'Other', ownerEmail: 'other@example.com' } },
            },
          },
        },
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${other.id}/profile`,
        headers: sk(),
        payload: { company: 'x' },
      });
      expect(res.statusCode).toBe(404);
      expect(code(res.json() as Json)).toBe('END_USER_NOT_FOUND');
    });

    it('/users/me carries the profile', async () => {
      const u = await signUp('me-read@example.com');
      await patchMine(u.token, { company: 'Acme' });
      const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: asUser(u.token) });
      expect(me.json().data).toMatchObject({ profile: { company: 'Acme' }, onboardingCompletedAt: null });
    });
  });

  describe('onboarding', () => {
    it('refuses until every required field is answered, then completes once', async () => {
      const u = await signUp('onboard@example.com');
      await patchMine(u.token, { company: 'Acme' });
      const early = await completeMine(u.token);
      expect(early.status).toBe(409);
      expect(code(early.body)).toBe('PROFILE_INCOMPLETE');
      expect(details(early.body).missing).toEqual(['team_size']);

      await patchMine(u.token, { team_size: '1' });
      const done = await completeMine(u.token);
      expect(done.status).toBe(200);
      const completedAt = (done.body.data as Json).onboardingCompletedAt as string;
      expect(completedAt).toEqual(expect.any(String));
      const again = await completeMine(u.token);
      expect((again.body.data as Json).onboardingCompletedAt).toBe(completedAt);

      expect(await events('user.onboarding_completed')).toEqual([{ userId: u.id, completedAt, via: 'self' }]);
    });

    it(`${RACERS} racing completions emit one event`, async () => {
      const u = await signUp('onboard-race@example.com');
      await patchMine(u.token, { company: 'Acme', team_size: '11+' });
      const results = await Promise.all(Array.from({ length: RACERS }, () => completeMine(u.token)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => (r.body.data as Json).onboardingCompletedAt)).size).toBe(1);
      expect(await events('user.onboarding_completed')).toHaveLength(1);
    });

    it('an operator can answer and complete for a user', async () => {
      const u = await signUp('operator@example.com');
      const base = `/api/v1/tenant/applications/${appId}/end-users/${u.id}`;
      const set = await app.inject({
        method: 'PATCH',
        url: `${base}/profile`,
        headers: op(),
        payload: { company: 'Acme', team_size: '1', plan_tier: 'pro' },
      });
      expect(set.statusCode).toBe(200);
      const done = await app.inject({ method: 'POST', url: `${base}/onboarding/complete`, headers: op() });
      expect(done.statusCode).toBe(200);
      expect(await events('user.onboarding_completed')).toEqual([expect.objectContaining({ via: 'operator' })]);
    });
  });

  describe('erasure and export', () => {
    it('the DSAR export includes the answers and erasure empties them', async () => {
      const u = await signUp('gone@example.com');
      await patchMine(u.token, { company: 'Acme', team_size: '1' });
      await completeMine(u.token);

      const exported = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${appId}/end-users/${u.id}/export`,
        headers: op(),
      });
      const doc = JSON.parse(exported.body) as { endUser: Json };
      expect(doc.endUser).toMatchObject({ profile: { company: 'Acme', team_size: '1' }, onboardingCompletedAt: expect.any(String) });

      const erase = await app.inject({
        method: 'DELETE',
        url: `/api/v1/tenant/applications/${appId}/end-users/${u.id}?erasure=true`,
        headers: op(),
      });
      expect(erase.statusCode).toBe(200);
      expect((await prisma.endUser.findUniqueOrThrow({ where: { id: u.id } })).profile).toEqual({});

      const write = await app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${u.id}/profile`,
        headers: sk(),
        payload: { company: 'Back' },
      });
      expect(write.statusCode).toBe(410);
      expect(code(write.json() as Json)).toBe('END_USER_ERASED');
    });
  });
});
