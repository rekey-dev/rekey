/**
 * The refresh-token reuse window (lib/refresh-reuse-window.ts), end-user and
 * operator, through the public routes.
 *
 * What it must hold, in the order the suite proves it:
 *   1. Eight concurrent refreshes of one token: one winner, seven
 *      REFRESH_TOKEN_RACED, nothing revoked, the user's other sessions live.
 *   2. A replay inside the window AFTER the successor has been used revokes
 *      every session (the chain moved on; this is a stolen copy).
 *   3. A replay after the window revokes every session.
 *   4. Every in-window replay leaves a security event with its IP and UA.
 *   5. A retry whose first response was lost is RACED, not a cascade, and the
 *      same retry after the window still is a cascade.
 * Plus the request-side disqualifiers (a foreign fingerprint, another
 * Application's key) and the pure rule's boundaries.
 *
 * Assertions are on the wire and on database rows, never on mocks.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashRefreshToken, rotateRefreshToken } from '../src/lib/refresh-tokens.js';
import { devicesService } from '../src/modules/devices/devices.service.js';
import { hashTenantRefreshToken } from '../src/lib/tenant-refresh-tokens.js';
import { judgeReplay, REFRESH_REUSE_WINDOW_MS, type ReuseWindowRow } from '../src/lib/refresh-reuse-window.js';
import { makeEndUser as makeEndUserFor } from './device-fixtures.js';

const PASSWORD = 'pw-one-two-three';
const RACERS = 8;
const UA = 'reuse-window-test/1.0';
const IP = '203.0.113.7';

interface EndUserSession {
  accessToken: string;
  refreshToken: string;
  deviceId: string | null;
  endUser: { id: string };
}

interface OperatorSession {
  user: { id: string };
  accessToken: string;
  refreshToken: string;
  activeTenantId: string;
}

describe('refresh-token reuse window', () => {
  let app: FastifyInstance;
  let operatorToken: string;
  let tenantId: string;
  let appId: string;
  let liveKey: string;
  let otherKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const opAuth = (): { authorization: string } => ({ authorization: `Bearer ${operatorToken}` });

  async function makeApplication(slug: string): Promise<{ id: string; key: string }> {
    const id = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: opAuth(),
        payload: { name: slug, slug },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${id}/api-keys`,
        headers: opAuth(),
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    return { id, key };
  }

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    const op = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `rw-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => r.json().data as OperatorSession);
    operatorToken = op.accessToken;
    tenantId = op.activeTenantId;
    const a = await makeApplication(`rw-${slug}`);
    appId = a.id;
    liveKey = a.key;
    otherKey = (await makeApplication(`rw-other-${slug}`)).key;
  });

  // ---------- end-user helpers ----------

  function signIn(email: string, device?: { fingerprint: string }): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email, password: PASSWORD, ...(device && { device }) },
    });
  }

  function refresh(
    refreshToken: string,
    opts: { key?: string; device?: { fingerprint: string } } = {},
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${opts.key ?? liveKey}`, 'user-agent': UA },
      remoteAddress: IP,
      payload: { refreshToken, ...(opts.device && { device: opts.device }) },
    });
  }

  /** A user with `sessions` independent live sessions (think: devices). */
  async function userWithSessions(
    email: string,
    sessions: number,
  ): Promise<{ userId: string; sessions: EndUserSession[] }> {
    const userId = await makeEndUserFor(app, operatorToken, appId, email, PASSWORD);
    const out: EndUserSession[] = [];
    for (let i = 0; i < sessions; i++) {
      const r = await signIn(email);
      expect(r.statusCode).toBe(200);
      out.push(r.json().data as EndUserSession);
    }
    return { userId, sessions: out };
  }

  const liveRows = (endUserId: string): Promise<number> =>
    prisma.refreshToken.count({ where: { endUserId, revokedAt: null } });

  async function wasFamilyRevoked(endUserId: string): Promise<boolean> {
    const u = await prisma.endUser.findUniqueOrThrow({ where: { id: endUserId } });
    return u.sessionsInvalidBefore !== null;
  }

  async function ageRotation(raw: string): Promise<void> {
    await prisma.refreshToken.update({
      where: { tokenHash: hashRefreshToken(raw) },
      data: { revokedAt: new Date(Date.now() - REFRESH_REUSE_WINDOW_MS - 1_000) },
    });
  }

  const events = (type: string, actorId: string) =>
    prisma.securityEvent.findMany({ where: { type, actorId }, orderBy: { createdAt: 'asc' } });

  // ---------- (1) + (4) concurrency ----------

  it(`${RACERS} concurrent refreshes of one token: one winner, the rest RACED, no session lost`, async () => {
    const { userId, sessions } = await userWithSessions('race8@example.com', 3);
    const [racing, laptop, phone] = sessions as [EndUserSession, EndUserSession, EndUserSession];

    const results = await Promise.all(Array.from({ length: RACERS }, () => refresh(racing.refreshToken)));
    const winners = results.filter((r) => r.statusCode === 200);
    const losers = results.filter((r) => r.statusCode !== 200);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(RACERS - 1);
    for (const r of losers) {
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('REFRESH_TOKEN_RACED');
    }

    // Nothing was revoked: no per-user stamp, all three sessions have a live
    // head, and each of them still rotates.
    expect(await wasFamilyRevoked(userId)).toBe(false);
    expect(await liveRows(userId)).toBe(3);
    const successor = (winners[0]!.json().data as EndUserSession).refreshToken;
    for (const t of [successor, laptop.refreshToken, phone.refreshToken]) {
      expect((await refresh(t)).statusCode).toBe(200);
    }

    // (4) one event per forgiven replay, carrying the replayer's IP and UA.
    const raced = await events('user.refresh_token_raced', userId);
    expect(raced).toHaveLength(RACERS - 1);
    const presented = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(racing.refreshToken) },
    });
    for (const e of raced) {
      expect(e.actorType).toBe('end_user');
      expect(e.actorId).toBe(userId);
      expect(e.applicationId).toBe(appId);
      expect(e.tenantId).toBe(tenantId);
      expect(e.ip).toBe(IP);
      expect(e.userAgent).toBe(UA);
      const m = e.metadata as Record<string, unknown>;
      expect(m.presentedTokenId).toBe(presented.id);
      expect(m.successorTokenId).toBe(presented.replacedById);
      expect(m.sessionId).toBe(presented.sessionId);
    }
    expect(await events('user.refresh_token_reused', userId)).toHaveLength(0);
  });

  // ---------- (2) successor already used ----------

  it('a replay inside the window after the successor was used revokes every session', async () => {
    const { userId, sessions } = await userWithSessions('spent@example.com', 2);
    const [s] = sessions as [EndUserSession];

    const first = await refresh(s.refreshToken);
    expect(first.statusCode).toBe(200);
    const second = await refresh((first.json().data as EndUserSession).refreshToken);
    expect(second.statusCode).toBe(200);

    // Still well inside the window for the first rotation.
    const replay = await refresh(s.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(await liveRows(userId)).toBe(0);
    expect(await wasFamilyRevoked(userId)).toBe(true);

    const reused = await events('user.refresh_token_reused', userId);
    expect(reused).toHaveLength(1);
    expect((reused[0]!.metadata as { reason: string }).reason).toBe('successor_spent');
    expect(reused[0]!.ip).toBe(IP);
    expect(await events('user.refresh_token_raced', userId)).toHaveLength(0);
  });

  it('a replay inside the window after the successor was signed out revokes every session', async () => {
    const { userId, sessions } = await userWithSessions('signed-out@example.com', 2);
    const [s] = sessions as [EndUserSession];
    const first = await refresh(s.refreshToken);
    const successor = (first.json().data as EndUserSession).refreshToken;
    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { refreshToken: successor },
    });
    expect(out.statusCode).toBe(200);

    const replay = await refresh(s.refreshToken);
    expect(replay.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(await liveRows(userId)).toBe(0);
  });

  // ---------- (3) outside the window ----------

  it('a replay after the window revokes every session', async () => {
    const { userId, sessions } = await userWithSessions('late@example.com', 2);
    const [s] = sessions as [EndUserSession];
    expect((await refresh(s.refreshToken)).statusCode).toBe(200);
    await ageRotation(s.refreshToken);

    const replay = await refresh(s.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(await liveRows(userId)).toBe(0);
    expect(await wasFamilyRevoked(userId)).toBe(true);
    const reused = await events('user.refresh_token_reused', userId);
    expect((reused[0]!.metadata as { reason: string }).reason).toBe('outside_window');
  });

  // ---------- (5) lost response ----------

  it('a retry after a lost response is RACED and costs no other device; the same retry after the window cascades', async () => {
    const { userId, sessions } = await userWithSessions('lost@example.com', 2);
    const [mobile, desktop] = sessions as [EndUserSession, EndUserSession];

    // The rotation commits; the response never reaches the client.
    const lost = await refresh(mobile.refreshToken);
    expect(lost.statusCode).toBe(200);

    const retry = await refresh(mobile.refreshToken);
    expect(retry.statusCode).toBe(401);
    expect(retry.json().error.code).toBe('REFRESH_TOKEN_RACED');
    expect(await wasFamilyRevoked(userId)).toBe(false);
    // The desktop session is untouched and keeps rotating.
    expect((await refresh(desktop.refreshToken)).statusCode).toBe(200);
    expect(await events('user.refresh_token_raced', userId)).toHaveLength(1);

    // A client that keeps the spent token and retries later is back to reuse.
    await ageRotation(mobile.refreshToken);
    const late = await refresh(mobile.refreshToken);
    expect(late.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(await liveRows(userId)).toBe(0);
  });

  // ---------- request-side disqualifiers ----------

  it('an in-window replay from a different device fingerprint is reuse, not a race', async () => {
    const userId = await makeEndUserFor(app, operatorToken, appId, 'fp@example.com', PASSWORD);
    const bound = (await signIn('fp@example.com', { fingerprint: 'fp-owner-000001' })).json().data as EndUserSession;
    expect(bound.deviceId).toBeTruthy();

    expect((await refresh(bound.refreshToken, { device: { fingerprint: 'fp-owner-000001' } })).statusCode).toBe(200);
    // The same machine racing itself is forgiven...
    const same = await refresh(bound.refreshToken, { device: { fingerprint: 'fp-owner-000001' } });
    expect(same.json().error.code).toBe('REFRESH_TOKEN_RACED');
    expect(await liveRows(userId)).toBe(1);
    // ...a different one is not.
    const other = await refresh(bound.refreshToken, { device: { fingerprint: 'fp-thief-000001' } });
    expect(other.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(await liveRows(userId)).toBe(0);
    const reused = await events('user.refresh_token_reused', userId);
    expect((reused[0]!.metadata as { reason: string }).reason).toBe('device_mismatch');
  });

  it('a request that passed the lookup and lost the rotation is RACED, deterministically', async () => {
    // Real concurrency reaches this door only some of the time (the racers
    // that read the row before the winner committed). Pinned here: the
    // presented token is rotated out from under the request at the device
    // preflight, the last read before its own rotation.
    const userId = await makeEndUserFor(app, operatorToken, appId, 'midflight@example.com', PASSWORD);
    const s = (await signIn('midflight@example.com', { fingerprint: 'fp-midflight-01' })).json().data as EndUserSession;
    const presented = await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashRefreshToken(s.refreshToken) } });
    const real = devicesService.preflight.bind(devicesService);
    const spy = vi.spyOn(devicesService, 'preflight').mockImplementationOnce(async (input) => {
      await rotateRefreshToken(presented);
      return real(input);
    });
    try {
      const raced = await refresh(s.refreshToken, { device: { fingerprint: 'fp-midflight-01' } });
      expect(raced.statusCode).toBe(401);
      expect(raced.json().error.code).toBe('REFRESH_TOKEN_RACED');
    } finally {
      spy.mockRestore();
    }
    expect(await wasFamilyRevoked(userId)).toBe(false);
    expect(await liveRows(userId)).toBe(1);
    const [event] = await events('user.refresh_token_raced', userId);
    expect((event!.metadata as { via: string }).via).toBe('rotation_race');
  });

  it('an in-window replay that sends a fingerprint against an unbound chain is reuse', async () => {
    const { userId, sessions } = await userWithSessions('unbound@example.com', 1);
    const [s] = sessions as [EndUserSession];
    expect((await refresh(s.refreshToken)).statusCode).toBe(200);
    const replay = await refresh(s.refreshToken, { device: { fingerprint: 'fp-thief-000002' } });
    expect(replay.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(await liveRows(userId)).toBe(0);
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(0);
  });

  it("an in-window replay under another Application's key is reuse", async () => {
    const { userId, sessions } = await userWithSessions('cross@example.com', 1);
    const [s] = sessions as [EndUserSession];
    expect((await refresh(s.refreshToken)).statusCode).toBe(200);
    const replay = await refresh(s.refreshToken, { key: otherKey });
    expect(replay.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(await liveRows(userId)).toBe(0);
  });

  // ---------- operator ----------

  function operatorRefresh(refreshToken: string): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/refresh',
      headers: { 'user-agent': UA },
      remoteAddress: IP,
      payload: { refreshToken },
    });
  }

  async function operatorWithSessions(sessions: number): Promise<{ id: string; sessions: OperatorSession[] }> {
    const email = `op-${Math.random().toString(36).slice(2, 10)}@example.com`;
    const first = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email, password: PASSWORD, workspaceName: 'Race Co' },
      })
      .then((r) => r.json().data as OperatorSession);
    const out = [first];
    for (let i = 1; i < sessions; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-in',
        payload: { email, password: PASSWORD },
      });
      expect(r.statusCode).toBe(200);
      out.push(r.json().data as OperatorSession);
    }
    return { id: first.user.id, sessions: out };
  }

  const liveOperatorRows = (tenantUserId: string): Promise<number> =>
    prisma.tenantRefreshToken.count({ where: { tenantUserId, revokedAt: null } });

  it(`operator: ${RACERS} concurrent refreshes, one winner, the rest RACED, no session lost`, async () => {
    const op = await operatorWithSessions(2);
    const [racing, other] = op.sessions as [OperatorSession, OperatorSession];

    const results = await Promise.all(Array.from({ length: RACERS }, () => operatorRefresh(racing.refreshToken)));
    const winners = results.filter((r) => r.statusCode === 200);
    expect(winners).toHaveLength(1);
    for (const r of results.filter((x) => x.statusCode !== 200)) {
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('REFRESH_TOKEN_RACED');
    }
    const user = await prisma.tenantUser.findUniqueOrThrow({ where: { id: op.id } });
    expect(user.sessionsInvalidBefore).toBeNull();
    expect(await liveOperatorRows(op.id)).toBe(2);
    expect((await operatorRefresh((winners[0]!.json().data as OperatorSession).refreshToken)).statusCode).toBe(200);
    expect((await operatorRefresh(other.refreshToken)).statusCode).toBe(200);

    const raced = await events('operator.refresh_token_raced', op.id);
    expect(raced).toHaveLength(RACERS - 1);
    for (const e of raced) {
      expect(e.actorType).toBe('operator');
      expect(e.actorId).toBe(op.id);
      expect(e.tenantId).toBe(racing.activeTenantId);
      expect(e.ip).toBe(IP);
      expect(e.userAgent).toBe(UA);
    }
  });

  it('operator: an in-window replay after the successor was used revokes every session', async () => {
    const op = await operatorWithSessions(2);
    const [s] = op.sessions as [OperatorSession];
    const first = await operatorRefresh(s.refreshToken);
    expect(first.statusCode).toBe(200);
    expect((await operatorRefresh((first.json().data as OperatorSession).refreshToken)).statusCode).toBe(200);

    const replay = await operatorRefresh(s.refreshToken);
    expect(replay.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(await liveOperatorRows(op.id)).toBe(0);
    const reused = await events('operator.refresh_token_reused', op.id);
    expect(reused).toHaveLength(1);
    expect((reused[0]!.metadata as { reason: string }).reason).toBe('successor_spent');
  });

  it('operator: a lost-response retry is RACED; after the window it revokes every session', async () => {
    const op = await operatorWithSessions(2);
    const [s, other] = op.sessions as [OperatorSession, OperatorSession];
    expect((await operatorRefresh(s.refreshToken)).statusCode).toBe(200);

    const retry = await operatorRefresh(s.refreshToken);
    expect(retry.json().error.code).toBe('REFRESH_TOKEN_RACED');
    expect((await operatorRefresh(other.refreshToken)).statusCode).toBe(200);

    await prisma.tenantRefreshToken.update({
      where: { tokenHash: hashTenantRefreshToken(s.refreshToken) },
      data: { revokedAt: new Date(Date.now() - REFRESH_REUSE_WINDOW_MS - 1_000) },
    });
    const late = await operatorRefresh(s.refreshToken);
    expect(late.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(await liveOperatorRows(op.id)).toBe(0);
    const reused = await events('operator.refresh_token_reused', op.id);
    expect((reused[0]!.metadata as { reason: string }).reason).toBe('outside_window');
  });
});

describe('judgeReplay', () => {
  const now = new Date('2026-09-23T12:00:00.000Z');
  const W = 15_000;
  const presented = (ageMs: number): ReuseWindowRow => ({
    id: 't0',
    sessionId: 's',
    revokedAt: new Date(now.getTime() - ageMs),
    replacedById: 't1',
    expiresAt: new Date(now.getTime() + 1e9),
  });
  const successor: ReuseWindowRow = {
    id: 't1',
    sessionId: 's',
    revokedAt: null,
    replacedById: null,
    expiresAt: new Date(now.getTime() + 1e9),
  };

  it('forgives a replay just inside the window, and a slightly future rotation (clock skew)', () => {
    expect(judgeReplay(presented(W - 1), successor, now, W)).toEqual({ kind: 'raced', msSinceRotation: W - 1 });
    expect(judgeReplay(presented(-50), successor, now, W)).toEqual({ kind: 'raced', msSinceRotation: 0 });
  });

  it('refuses at the window edge and beyond', () => {
    expect(judgeReplay(presented(W), successor, now, W)).toEqual({ kind: 'reused', reason: 'outside_window' });
  });

  it('is off when the window is 0', () => {
    expect(judgeReplay(presented(0), successor, now, 0)).toEqual({ kind: 'reused', reason: 'window_disabled' });
  });

  it('refuses a token that was revoked rather than rotated', () => {
    expect(judgeReplay({ ...presented(0), replacedById: null }, successor, now, W).kind).toBe('reused');
  });

  it('refuses when the successor is gone, foreign, spent, revoked or expired', () => {
    const p = presented(1);
    expect(judgeReplay(p, null, now, W)).toEqual({ kind: 'reused', reason: 'successor_missing' });
    expect(judgeReplay(p, { ...successor, id: 'tX' }, now, W)).toEqual({ kind: 'reused', reason: 'successor_missing' });
    expect(judgeReplay(p, { ...successor, sessionId: 'other' }, now, W)).toEqual({
      kind: 'reused',
      reason: 'successor_missing',
    });
    expect(judgeReplay(p, { ...successor, replacedById: 't2', revokedAt: now }, now, W)).toEqual({
      kind: 'reused',
      reason: 'successor_spent',
    });
    expect(judgeReplay(p, { ...successor, revokedAt: now }, now, W)).toEqual({ kind: 'reused', reason: 'successor_spent' });
    expect(judgeReplay(p, { ...successor, expiresAt: now }, now, W)).toEqual({
      kind: 'reused',
      reason: 'successor_expired',
    });
  });
});
