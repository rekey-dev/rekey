/**
 * A sign-in or a refresh that is in flight while the account changes hands.
 *
 * A claim, a password change and sign-out everywhere each end every session
 * the account has. A request that checked its credential just before, and
 * writes its session just after, must not come out holding a live one: the
 * person it belongs to is the one the revocation was aimed at.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

const RACERS = 8;
const ROUNDS = 5;
const ATTACKER_PASSWORD = 'attacker-pw-one-two-three';

interface Pair {
  accessToken: string;
  refreshToken: string;
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pairsFrom = (responses: LightMyRequestResponse[]): Pair[] =>
  responses.filter((r) => r.statusCode === 200).map((r) => r.json().data as Pair);

describe('End-user sessions racing a revocation of every session', () => {
  operatorsConfirmTheirEmail();
  let app: FastifyInstance;
  let secretKey: string;
  let publishableKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const sk = (): Record<string, string> => ({ authorization: `Bearer ${secretKey}` });
  const pk = (): Record<string, string> => ({ authorization: `Bearer ${publishableKey}` });
  const post = (url: string, payload: unknown, headers: Record<string, string>): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'POST', url: `/api/v1/auth${url}`, headers, payload: payload as never });
  const me = (accessToken: string): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...pk(), 'x-rekey-user-token': accessToken } });

  async function application(): Promise<void> {
    const slug = `race-${Math.random().toString(36).slice(2, 8)}`;
    const token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: slug },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const operator = { authorization: `Bearer ${token}` };
    const applicationId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: operator, payload: { name: slug, slug } })
      .then((r) => (r.json().data as { id: string }).id);
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: operator,
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    publishableKey = await prisma.application
      .findUniqueOrThrow({ where: { id: applicationId }, select: { publicKey: true } })
      .then((a) => a.publicKey);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: operator,
      payload: { methods: ['password', 'magic_link'], appUrl: 'https://app.example.com' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
  }

  async function accountWithSessions(email: string): Promise<{ id: string; sessions: Pair[] }> {
    const signUp = await post('/sign-up', { email, password: ATTACKER_PASSWORD }, pk());
    expect(signUp.statusCode, signUp.body).toBe(201);
    const first = signUp.json().data as Pair & { endUser: { id: string } };
    const sessions: Pair[] = [first];
    while (sessions.length < RACERS) {
      const res = await post('/sign-in', { email, password: ATTACKER_PASSWORD }, pk());
      expect(res.statusCode, res.body).toBe(200);
      sessions.push(res.json().data as Pair);
    }
    return { id: first.endUser.id, sessions };
  }

  /** Every pair a racer was handed must be dead: on `/me` first, then on `/refresh`. */
  async function expectNoneAlive(racers: LightMyRequestResponse[], what: string): Promise<void> {
    const pairs = pairsFrom(racers);
    for (const pair of pairs) {
      expect((await me(pair.accessToken)).statusCode, `${what}: a racer's access token still works`).toBe(401);
    }
    for (const pair of pairs) {
      expect(
        (await post('/refresh', { refreshToken: pair.refreshToken }, pk())).statusCode,
        `${what}: a racer's refresh token still works`,
      ).toBe(401);
    }
  }

  it(`${RACERS} sign-ins and ${RACERS} refreshes in flight during a claim leave the first registrant no session`, async () => {
    await application();
    for (let round = 0; round < ROUNDS; round += 1) {
      const email = `victim-${round}@example.com`;
      const { id, sessions } = await accountWithSessions(email);
      const link = await post('/magic-link/request', { email }, sk());
      const token = (link.json().data as { magicLinkToken: string }).magicLinkToken;

      const signIns = Array.from({ length: RACERS }, () =>
        post('/sign-in', { email, password: ATTACKER_PASSWORD }, pk()),
      );
      const refreshes = sessions.map(async (s, i) => {
        await pause(10 + i * 3);
        return post('/refresh', { refreshToken: s.refreshToken }, pk());
      });
      await pause(15);
      const verified = await post('/magic-link/verify', { token }, pk());
      expect(verified.statusCode, verified.body).toBe(200);
      const owner = verified.json().data as Pair;
      const racers = await Promise.all([...signIns, ...refreshes]);

      const live = await prisma.refreshToken.count({ where: { endUserId: id, revokedAt: null } });
      expect(live, `round ${round}: only the session of whoever proved the mailbox may be live`).toBe(1);
      expect((await me(owner.accessToken)).statusCode).toBe(200);
      await expectNoneAlive(racers, `round ${round}`);
      const after = await post('/sign-in', { email, password: ATTACKER_PASSWORD }, pk());
      expect(after.statusCode, `round ${round}: the first registrant's password must be gone`).toBe(401);
    }
  }, 120_000);

  it(`${RACERS} old-password sign-ins and ${RACERS} refreshes in flight during a password change get no session`, async () => {
    await application();
    for (let round = 0; round < ROUNDS; round += 1) {
      const email = `changer-${round}@example.com`;
      const { id, sessions } = await accountWithSessions(email);
      const actor = sessions[0]!;

      const signIns = Array.from({ length: RACERS }, () =>
        post('/sign-in', { email, password: ATTACKER_PASSWORD }, pk()),
      );
      const refreshes = sessions.slice(1).map(async (s, i) => {
        await pause(60 + i * 8);
        return post('/refresh', { refreshToken: s.refreshToken }, pk());
      });
      await pause(5);
      const changed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: { ...sk(), 'x-rekey-user-token': actor.accessToken },
        payload: { currentPassword: ATTACKER_PASSWORD, newPassword: 'a-new-pw-one-two-three' },
      });
      expect(changed.statusCode, changed.body).toBe(200);
      const racers = await Promise.all([...signIns, ...refreshes]);

      const live = await prisma.refreshToken.count({ where: { endUserId: id, revokedAt: null } });
      expect(live, `round ${round}: a password change ends every session`).toBe(0);
      await expectNoneAlive(racers, `round ${round}`);
    }
  }, 120_000);

  it(`${RACERS} refreshes in flight during sign-out everywhere get no session`, async () => {
    await application();
    for (let round = 0; round < ROUNDS; round += 1) {
      const email = `leaver-${round}@example.com`;
      const { id, sessions } = await accountWithSessions(email);
      const actor = sessions[0]!;
      const refreshes = sessions.slice(1).map(async (s, i) => {
        await pause(i);
        return post('/refresh', { refreshToken: s.refreshToken }, pk());
      });
      await pause(2);
      const out = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-out-everywhere',
        headers: { ...sk(), 'x-rekey-user-token': actor.accessToken },
      });
      expect(out.statusCode, out.body).toBe(200);
      const racers = await Promise.all(refreshes);
      const live = await prisma.refreshToken.count({ where: { endUserId: id, revokedAt: null } });
      expect(live, `round ${round}: sign-out everywhere ends every session`).toBe(0);
      await expectNoneAlive(racers, `round ${round}`);
    }
  }, 120_000);
});

describe('Operator sessions racing a revocation of every session', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const post = (url: string, payload: unknown, accessToken?: string): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant/auth${url}`,
      ...(accessToken && { headers: { authorization: `Bearer ${accessToken}` } }),
      payload: payload as never,
    });
  const me = (accessToken: string): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'GET', url: '/api/v1/tenant/auth/me', headers: { authorization: `Bearer ${accessToken}` } });

  async function operatorWithSessions(email: string): Promise<{ id: string; sessions: Pair[] }> {
    const signUp = await post('/sign-up', { email, password: ATTACKER_PASSWORD, workspaceName: 'Staging' });
    expect(signUp.statusCode, signUp.body).toBe(201);
    const first = signUp.json().data as Pair & { user: { id: string } };
    const sessions: Pair[] = [first];
    while (sessions.length < RACERS) {
      const res = await post('/sign-in', { email, password: ATTACKER_PASSWORD });
      expect(res.statusCode, res.body).toBe(200);
      sessions.push(res.json().data as Pair);
    }
    return { id: first.user.id, sessions };
  }

  async function expectNoneAlive(racers: LightMyRequestResponse[], what: string): Promise<void> {
    const pairs = pairsFrom(racers);
    for (const pair of pairs) {
      expect((await me(pair.accessToken)).statusCode, `${what}: a racer's access token still works`).toBe(401);
    }
    for (const pair of pairs) {
      expect(
        (await post('/refresh', { refreshToken: pair.refreshToken })).statusCode,
        `${what}: a racer's refresh token still works`,
      ).toBe(401);
    }
  }

  it(`${RACERS} sign-ins and ${RACERS} refreshes in flight during a claim leave the first registrant no session`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const email = `victim-op-${round}-${Math.random().toString(36).slice(2, 7)}@example.com`;
      const { id, sessions } = await operatorWithSessions(email);
      const link = await post('/magic-link/request', { email });
      const token = (link.json().data as { token: string }).token;
      expect(token).toBeTruthy();

      const signIns = Array.from({ length: RACERS }, () => post('/sign-in', { email, password: ATTACKER_PASSWORD }));
      const refreshes = sessions.map(async (s, i) => {
        await pause(10 + i * 3);
        return post('/refresh', { refreshToken: s.refreshToken });
      });
      await pause(15);
      const verified = await post('/magic-link/verify', { token });
      expect(verified.statusCode, verified.body).toBe(200);
      const owner = verified.json().data as Pair;
      const racers = await Promise.all([...signIns, ...refreshes]);

      const live = await prisma.tenantRefreshToken.count({ where: { tenantUserId: id, revokedAt: null } });
      expect(live, `round ${round}: only the session of whoever proved the mailbox may be live`).toBe(1);
      expect((await me(owner.accessToken)).statusCode).toBe(200);
      await expectNoneAlive(racers, `round ${round}`);
      const after = await post('/sign-in', { email, password: ATTACKER_PASSWORD });
      expect(after.statusCode, `round ${round}: the first registrant's password must be gone`).toBe(401);
    }
  }, 120_000);

  it(`${RACERS} old-password sign-ins and ${RACERS} refreshes in flight during a password change get no session`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const email = `changer-op-${round}-${Math.random().toString(36).slice(2, 7)}@example.com`;
      const { id, sessions } = await operatorWithSessions(email);
      const actor = sessions[0]!;
      const signIns = Array.from({ length: RACERS }, () => post('/sign-in', { email, password: ATTACKER_PASSWORD }));
      const refreshes = sessions.slice(1).map(async (s, i) => {
        await pause(60 + i * 8);
        return post('/refresh', { refreshToken: s.refreshToken });
      });
      await pause(5);
      const changed = await post(
        '/change-password',
        { currentPassword: ATTACKER_PASSWORD, newPassword: 'Xk9-new-pw-one-two-three' },
        actor.accessToken,
      );
      expect(changed.statusCode, changed.body).toBe(200);
      const racers = await Promise.all([...signIns, ...refreshes]);
      const live = await prisma.tenantRefreshToken.count({ where: { tenantUserId: id, revokedAt: null } });
      expect(live, `round ${round}: a password change ends every session`).toBe(0);
      await expectNoneAlive(racers, `round ${round}`);
    }
  }, 120_000);

  it(`${RACERS} refreshes in flight during sign-out everywhere get no session`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const email = `leaver-op-${round}-${Math.random().toString(36).slice(2, 7)}@example.com`;
      const { id, sessions } = await operatorWithSessions(email);
      const actor = sessions[0]!;
      const refreshes = sessions.slice(1).map(async (s, i) => {
        await pause(i);
        return post('/refresh', { refreshToken: s.refreshToken });
      });
      await pause(2);
      const out = await post('/sign-out-everywhere', {}, actor.accessToken);
      expect(out.statusCode, out.body).toBe(200);
      const racers = await Promise.all(refreshes);
      const live = await prisma.tenantRefreshToken.count({ where: { tenantUserId: id, revokedAt: null } });
      expect(live, `round ${round}: sign-out everywhere ends every session`).toBe(0);
      await expectNoneAlive(racers, `round ${round}`);
    }
  }, 120_000);
});

/**
 * A refresh token the first registrant spent before the claim.
 *
 * Replaying a rotated token is how theft of a live session shows itself, and
 * the answer is to end every session. A token from before the last time every
 * session was ended cannot show that: whatever it belonged to is already
 * over. Answered as reuse, it would let the first registrant sign the owner
 * out everywhere, again and again, with one request each time.
 */
describe('A refresh token spent before every session was ended, replayed afterwards', () => {
  operatorsConfirmTheirEmail();
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const tenant = (url: string, payload: unknown, accessToken?: string): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant${url}`,
      ...(accessToken && { headers: { authorization: `Bearer ${accessToken}` } }),
      payload: payload as never,
    });

  it('end user: the owner stays signed in through repeated replays, and theft of a current token still ends everything', async () => {
    const slug = `replay-${Math.random().toString(36).slice(2, 8)}`;
    const op = await tenant('/auth/sign-up', { email: `op-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: slug });
    const operator = { authorization: `Bearer ${(op.json().data as { accessToken: string }).accessToken}` };
    const applicationId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: operator, payload: { name: slug, slug } })
      .then((r) => (r.json().data as { id: string }).id);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: operator,
      payload: { methods: ['password', 'magic_link'], appUrl: 'https://app.example.com' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const pk = { authorization: `Bearer ${application.publicKey}` };
    const post = (url: string, payload: unknown): Promise<LightMyRequestResponse> =>
      app.inject({ method: 'POST', url: `/api/v1/auth${url}`, headers: pk, payload: payload as never });
    const me = (accessToken: string): Promise<LightMyRequestResponse> =>
      app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...pk, 'x-rekey-user-token': accessToken } });

    const email = 'victim@example.com';
    const signUp = await post('/sign-up', { email, password: ATTACKER_PASSWORD });
    const squatter = signUp.json().data as Pair & { endUser: { id: string } };
    // The squatter refreshes once and keeps the spent token.
    expect((await post('/refresh', { refreshToken: squatter.refreshToken })).statusCode).toBe(200);
    const spent = squatter.refreshToken;

    const { issueMagicLinkToken } = await import('../src/lib/magic-link.js');
    const link = await issueMagicLinkToken({ applicationId, endUserId: squatter.endUser.id, email });
    const verified = await post('/magic-link/verify', { token: link.raw });
    expect(verified.statusCode, verified.body).toBe(200);
    let owner = verified.json().data as Pair;
    const stampAfterClaim = (await prisma.endUser.findUniqueOrThrow({ where: { id: squatter.endUser.id } })).sessionsInvalidBefore;

    for (let i = 0; i < 3; i += 1) {
      const replay = await post('/refresh', { refreshToken: spent });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code, `replay ${i}`).toBe('REFRESH_TOKEN_REVOKED');
      expect((await me(owner.accessToken)).statusCode, `replay ${i}: the owner is still signed in`).toBe(200);
    }
    const row = await prisma.endUser.findUniqueOrThrow({ where: { id: squatter.endUser.id } });
    expect(row.sessionsInvalidBefore?.getTime(), 'the stamp did not move').toBe(stampAfterClaim?.getTime());
    expect(await prisma.securityEvent.count({ where: { actorId: squatter.endUser.id, type: 'user.refresh_token_reused' } })).toBe(0);
    // "Sign the user in again to obtain a fresh session": the owner's own refresh still works.
    const refreshed = await post('/refresh', { refreshToken: owner.refreshToken });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const ownerSpent = owner.refreshToken;
    owner = refreshed.json().data as Pair;

    // Real theft: a token of the CURRENT generation, replayed after the reuse window.
    await prisma.refreshToken.updateMany({
      where: { endUserId: squatter.endUser.id, revokedAt: { not: null }, replacedById: { not: null }, createdAt: { gt: stampAfterClaim! } },
      data: { revokedAt: new Date(Date.now() - 3_600_000) },
    });
    const theft = await post('/refresh', { refreshToken: ownerSpent });
    expect(theft.statusCode).toBe(401);
    expect(theft.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect((await me(owner.accessToken)).statusCode, 'reuse of a current token ends every session').toBe(401);
    expect(await prisma.refreshToken.count({ where: { endUserId: squatter.endUser.id, revokedAt: null } })).toBe(0);
  });

  it('operator: the owner stays signed in through repeated replays, and theft of a current token still ends everything', async () => {
    const email = `victim-op-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const { operatorConfirmation } = await import('../src/modules/tenant-auth/operator-claim.js');
    expect(operatorConfirmation.possible()).toBe(true);
    const signUp = await tenant('/auth/sign-up', { email, password: ATTACKER_PASSWORD, workspaceName: 'Staging' });
    const squatter = signUp.json().data as Pair & { user: { id: string } };
    await prisma.tenantUser.update({ where: { id: squatter.user.id }, data: { emailVerified: false } });
    expect((await tenant('/auth/refresh', { refreshToken: squatter.refreshToken })).statusCode).toBe(200);
    const spent = squatter.refreshToken;
    const me = (accessToken: string): Promise<LightMyRequestResponse> =>
      app.inject({ method: 'GET', url: '/api/v1/tenant/auth/me', headers: { authorization: `Bearer ${accessToken}` } });

    const link = await tenant('/auth/magic-link/request', { email });
    const verified = await tenant('/auth/magic-link/verify', { token: (link.json().data as { token: string }).token });
    expect(verified.statusCode, verified.body).toBe(200);
    let owner = verified.json().data as Pair;
    const stampAfterClaim = (await prisma.tenantUser.findUniqueOrThrow({ where: { id: squatter.user.id } })).sessionsInvalidBefore;
    expect(stampAfterClaim).not.toBeNull();

    for (let i = 0; i < 3; i += 1) {
      const replay = await tenant('/auth/refresh', { refreshToken: spent });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code, `replay ${i}`).toBe('REFRESH_TOKEN_REVOKED');
      expect((await me(owner.accessToken)).statusCode, `replay ${i}: the owner is still signed in`).toBe(200);
    }
    const row = await prisma.tenantUser.findUniqueOrThrow({ where: { id: squatter.user.id } });
    expect(row.sessionsInvalidBefore?.getTime(), 'the stamp did not move').toBe(stampAfterClaim?.getTime());
    const refreshed = await tenant('/auth/refresh', { refreshToken: owner.refreshToken });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const ownerSpent = owner.refreshToken;
    owner = refreshed.json().data as Pair;

    await prisma.tenantRefreshToken.updateMany({
      where: { tenantUserId: squatter.user.id, revokedAt: { not: null }, replacedById: { not: null }, createdAt: { gt: stampAfterClaim! } },
      data: { revokedAt: new Date(Date.now() - 3_600_000) },
    });
    const theft = await tenant('/auth/refresh', { refreshToken: ownerSpent });
    expect(theft.statusCode).toBe(401);
    expect(theft.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect((await me(owner.accessToken)).statusCode, 'reuse of a current token ends every session').toBe(401);
  });
});
