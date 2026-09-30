/**
 * Skipping onboarding. Rekey records a skip and never acts on it: the client
 * app decides whether a skipped user is sent back to the form.
 *
 *   - Skip stamps `onboardingSkippedAt` once and emits `user.onboarding_skipped`
 *     once, however many race; it validates nothing.
 *   - Completing after a skip is allowed and keeps the skip time; `complete`
 *     still needs every required answer.
 *   - Skipping after completion is a no-op.
 *   - `onboardingStatus` is derived the same way on every surface.
 *   - The operator route is tenant-scoped and declares its access.
 *   - Erasure clears the skip time; the DSAR export carries it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { onboardingStatus } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const PASSWORD = 'pw-one-two-three';
const RACERS = 8;

type Json = Record<string, unknown>;

const SCHEMA = [
  { key: 'company', label: 'Company', type: 'text', requiredForOnboarding: true },
  { key: 'seats', label: 'Seats', type: 'number' },
];

interface Workspace {
  operator: string;
  appId: string;
  publicKey: string;
  secretKey: string;
}

describe('Onboarding skip', () => {
  let app: FastifyInstance;
  let ws: Workspace;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const bearer = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });
  const asUser = (token: string): Record<string, string> => ({
    authorization: `Bearer ${ws.publicKey}`,
    'x-rekey-user-token': token,
  });

  async function workspace(): Promise<Workspace> {
    const slug = `sk-${Math.random().toString(36).slice(2, 8)}`;
    const operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const created = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: bearer(operator), payload: { name: 'SK', slug } })
      .then((r) => r.json().data as { id: string; publicKey: string });
    const secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${created.id}/api-keys`,
        headers: bearer(operator),
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await prisma.webhookEndpoint.create({
      data: { applicationId: created.id, url: 'https://example.invalid/hook', secret: 'whsec_x', events: ['*'] },
    });
    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${created.id}/profile-schema`,
      headers: bearer(operator),
      payload: { fields: SCHEMA },
    });
    expect(put.statusCode).toBe(200);
    return { operator, appId: created.id, publicKey: created.publicKey, secretKey };
  }

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: bearer(ws.secretKey),
      payload: { email, password: PASSWORD },
    });
    const data = res.json().data as { endUser: { id: string }; accessToken: string };
    return { id: data.endUser.id, token: data.accessToken };
  }

  async function mine(token: string, action: 'skip' | 'complete'): Promise<{ status: number; body: Json }> {
    const res = await app.inject({ method: 'POST', url: `/api/v1/users/me/onboarding/${action}`, headers: asUser(token) });
    return { status: res.statusCode, body: res.json() as Json };
  }

  async function answer(token: string, patch: Json): Promise<void> {
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/users/me/profile', headers: asUser(token), payload: patch });
    expect(res.statusCode).toBe(200);
  }

  async function events(type: string): Promise<Json[]> {
    const rows = await prisma.webhookDelivery.findMany({
      where: { applicationId: ws.appId, eventType: type },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => (r.payload as { data: Json }).data);
  }

  const data = (body: Json): Json => body.data as Json;
  const code = (body: Json): string => (body.error as { code: string }).code;

  beforeEach(async () => {
    ws = await workspace();
  });

  it('derives the status: completed wins over skipped, skipped over pending', () => {
    const at = '2026-09-30T10:00:00.000Z';
    expect(onboardingStatus({ onboardingCompletedAt: null, onboardingSkippedAt: null })).toBe('pending');
    expect(onboardingStatus({ onboardingCompletedAt: null, onboardingSkippedAt: at })).toBe('skipped');
    expect(onboardingStatus({ onboardingCompletedAt: at, onboardingSkippedAt: null })).toBe('completed');
    expect(onboardingStatus({ onboardingCompletedAt: at, onboardingSkippedAt: at })).toBe('completed');
  });

  it('records a skip once, with nothing answered, and announces it once', async () => {
    const u = await signUp('skip@example.com');
    const first = await mine(u.token, 'skip');
    expect(first.status).toBe(200);
    const skippedAt = data(first.body).onboardingSkippedAt as string;
    expect(data(first.body)).toEqual({
      profile: {},
      onboardingCompletedAt: null,
      onboardingSkippedAt: expect.any(String),
      onboardingStatus: 'skipped',
    });

    const again = await mine(u.token, 'skip');
    expect(again.status).toBe(200);
    expect(data(again.body).onboardingSkippedAt).toBe(skippedAt);

    expect(await events('user.onboarding_skipped')).toEqual([{ userId: u.id, skippedAt, via: 'self' }]);
  });

  it(`${RACERS} racing skips store one time and emit one event`, async () => {
    const u = await signUp('skip-race@example.com');
    const results = await Promise.all(Array.from({ length: RACERS }, () => mine(u.token, 'skip')));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => data(r.body).onboardingSkippedAt)).size).toBe(1);
    expect(await events('user.onboarding_skipped')).toHaveLength(1);
  });

  it('completing after a skip still needs the required answers, then completes and keeps the skip time', async () => {
    const u = await signUp('skip-then-complete@example.com');
    const skippedAt = data((await mine(u.token, 'skip')).body).onboardingSkippedAt;

    const early = await mine(u.token, 'complete');
    expect(early.status).toBe(409);
    expect(code(early.body)).toBe('PROFILE_INCOMPLETE');

    await answer(u.token, { company: 'Acme' });
    const done = await mine(u.token, 'complete');
    expect(done.status).toBe(200);
    expect(data(done.body)).toMatchObject({
      onboardingCompletedAt: expect.any(String),
      onboardingSkippedAt: skippedAt,
      onboardingStatus: 'completed',
    });
    expect(await events('user.onboarding_completed')).toHaveLength(1);
  });

  it('skipping after completion changes nothing and emits nothing', async () => {
    const u = await signUp('complete-then-skip@example.com');
    await answer(u.token, { company: 'Acme' });
    const completedAt = data((await mine(u.token, 'complete')).body).onboardingCompletedAt;

    const skip = await mine(u.token, 'skip');
    expect(skip.status).toBe(200);
    expect(data(skip.body)).toMatchObject({ onboardingCompletedAt: completedAt, onboardingSkippedAt: null, onboardingStatus: 'completed' });
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: u.id } })).onboardingSkippedAt).toBeNull();
    expect(await events('user.onboarding_skipped')).toHaveLength(0);
  });

  it('every read surface carries the same status', async () => {
    const u = await signUp('surfaces@example.com');
    const read = async (): Promise<string[]> => {
      const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: asUser(u.token) });
      const authMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'x-rekey-user-token': u.token } });
      const byId = await app.inject({ method: 'GET', url: `/api/v1/users/${u.id}`, headers: bearer(ws.secretKey) });
      const insights = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${ws.appId}/end-users/${u.id}/insights`,
        headers: bearer(ws.operator),
      });
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${ws.appId}/end-users`,
        headers: bearer(ws.operator),
      });
      const row = (list.json().data as { items: Json[] }).items.find((i) => i.id === u.id)!;
      return [
        data(me.json() as Json).onboardingStatus as string,
        data(authMe.json() as Json).onboardingStatus as string,
        data(byId.json() as Json).onboardingStatus as string,
        (data(insights.json() as Json).profile as Json).onboardingStatus as string,
        row.onboardingStatus as string,
      ];
    };

    expect(await read()).toEqual(Array(5).fill('pending'));
    await mine(u.token, 'skip');
    expect(await read()).toEqual(Array(5).fill('skipped'));
    const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: asUser(u.token) });
    expect(data(me.json() as Json).onboardingSkippedAt).toEqual(expect.any(String));
    await answer(u.token, { company: 'Acme' });
    await mine(u.token, 'complete');
    expect(await read()).toEqual(Array(5).fill('completed'));
  });

  it('never gates sign-in on onboarding', async () => {
    const u = await signUp('ungated@example.com');
    await mine(u.token, 'skip');
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: bearer(ws.secretKey),
      payload: { email: 'ungated@example.com', password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
  });

  it('a secret key skips with via "server", and cannot reach another Application\'s user', async () => {
    const u = await signUp('server-skip@example.com');
    const res = await app.inject({ method: 'POST', url: `/api/v1/users/${u.id}/onboarding/skip`, headers: bearer(ws.secretKey) });
    expect(res.statusCode).toBe(200);
    expect(data(res.json() as Json).onboardingStatus).toBe('skipped');
    expect(await events('user.onboarding_skipped')).toEqual([expect.objectContaining({ via: 'server' })]);

    const home = ws;
    ws = await workspace();
    const stranger = await signUp('stranger@example.com');
    const probe = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${stranger.id}/onboarding/skip`,
      headers: bearer(home.secretKey),
    });
    expect(probe.statusCode).toBe(404);
    expect(code(probe.json() as Json)).toBe('END_USER_NOT_FOUND');
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: stranger.id } })).onboardingSkippedAt).toBeNull();
  });

  it('an operator skips with via "operator", and never across workspaces or Applications', async () => {
    const u = await signUp('operator-skip@example.com');
    const url = (appId: string, euid: string): string =>
      `/api/v1/tenant/applications/${appId}/end-users/${euid}/onboarding/skip`;
    const res = await app.inject({ method: 'POST', url: url(ws.appId, u.id), headers: bearer(ws.operator) });
    expect(res.statusCode).toBe(200);
    expect(await events('user.onboarding_skipped')).toEqual([expect.objectContaining({ via: 'operator' })]);

    const home = ws;
    ws = await workspace();
    const stranger = await signUp('operator-stranger@example.com');

    const otherWorkspace = await app.inject({ method: 'POST', url: url(ws.appId, stranger.id), headers: bearer(home.operator) });
    expect(otherWorkspace.statusCode).toBe(404);
    expect(code(otherWorkspace.json() as Json)).toBe('APPLICATION_NOT_FOUND');

    const smuggledUser = await app.inject({ method: 'POST', url: url(home.appId, stranger.id), headers: bearer(home.operator) });
    expect(smuggledUser.statusCode).toBe(404);
    expect(code(smuggledUser.json() as Json)).toBe('END_USER_NOT_FOUND');

    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: stranger.id } })).onboardingSkippedAt).toBeNull();
  });

  it('the operator route declares end-users:write', () => {
    const route = app.routeAccess.find(
      (r) => r.url === '/api/v1/tenant/applications/:id/end-users/:euid/onboarding/skip',
    );
    expect(route?.access).toEqual({ scope: 'end-users:write' });
  });

  it('the DSAR export carries the skip time and erasure clears it', async () => {
    const u = await signUp('erase-skip@example.com');
    await mine(u.token, 'skip');
    const exported = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${ws.appId}/end-users/${u.id}/export`,
      headers: bearer(ws.operator),
    });
    expect((JSON.parse(exported.body) as { endUser: Json }).endUser.onboardingSkippedAt).toEqual(expect.any(String));

    const erase = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${ws.appId}/end-users/${u.id}?erasure=true`,
      headers: bearer(ws.operator),
    });
    expect(erase.statusCode).toBe(200);
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: u.id } })).onboardingSkippedAt).toBeNull();

    const skip = await app.inject({ method: 'POST', url: `/api/v1/users/${u.id}/onboarding/skip`, headers: bearer(ws.secretKey) });
    expect(skip.statusCode).toBe(410);
    expect(code(skip.json() as Json)).toBe('END_USER_ERASED');
  });
});
