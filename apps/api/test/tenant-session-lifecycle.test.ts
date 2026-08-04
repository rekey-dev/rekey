/**
 * Operator session lifecycle — everything that happens to a panel session
 * after sign-in.
 *
 * `tenant-auth.test.ts` covers sign-up / sign-in / invitations / workspace
 * switching. The other half of the surface had no test at all: refresh
 * rotation and its reuse detection, sign-out, the session list and its
 * per-session revoke, sign-out-everywhere, forgot/reset-password, and
 * change-password. Those are the routes that decide whether a stolen operator
 * token stays useful — the panel is a workspace-takeover surface.
 *
 * `TENANT_SESSION_INVALID` (middleware/tenant-session.ts) is asserted here too:
 * it is the refusal every one of these routes leans on and nothing pinned it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

interface Session {
  user: { id: string; email: string };
  accessToken: string;
  refreshToken: string;
  activeTenantId: string;
}

describe('operator session lifecycle', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function uniqueEmail(tag: string): string {
    return `${tag}-${Math.random().toString(36).slice(2, 10)}@example.com`;
  }

  async function signUp(email: string): Promise<Session> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName: 'Session Co' },
    });
    expect(r.statusCode).toBe(201);
    return r.json().data as Session;
  }

  async function signIn(email: string, password = 'pw-one-two-three'): Promise<Session> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-in',
      payload: { email, password },
    });
    expect(r.statusCode).toBe(200);
    return r.json().data as Session;
  }

  function me(accessToken: string): ReturnType<typeof app.inject> {
    return app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  function refresh(refreshToken: string): ReturnType<typeof app.inject> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/refresh',
      payload: { refreshToken },
    });
  }

  // ---------- refresh ----------

  it('refresh rotates the pair and the new access token works', async () => {
    const s = await signUp(uniqueEmail('rot'));

    const res = await refresh(s.refreshToken);
    expect(res.statusCode).toBe(200);
    const next = res.json().data as Session;
    expect(next.refreshToken).not.toBe(s.refreshToken);
    expect(next.accessToken).toBeTypeOf('string');
    expect((await me(next.accessToken)).statusCode).toBe(200);

    // Rotation is a replace, not an append: exactly one live token remains.
    const live = await prisma.tenantRefreshToken.count({
      where: { tenantUserId: s.user.id, revokedAt: null },
    });
    expect(live).toBe(1);
  });

  it('replaying a rotated refresh token revokes the whole chain', async () => {
    const s = await signUp(uniqueEmail('reuse'));
    const rotated = (await refresh(s.refreshToken)).json().data as Session;

    // Replay the consumed token.
    const replay = await refresh(s.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('REFRESH_TOKEN_REUSED');

    // The precaution: the token issued by the legitimate rotation is dead too.
    const after = await refresh(rotated.refreshToken);
    expect(after.statusCode).toBe(401);
    expect(await prisma.tenantRefreshToken.count({
      where: { tenantUserId: s.user.id, revokedAt: null },
    })).toBe(0);
  });

  it('refresh with an unknown token is REFRESH_TOKEN_INVALID, not a 500', async () => {
    const res = await refresh('rp_op_not_a_real_refresh_token');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('refresh with an expired token is REFRESH_TOKEN_EXPIRED', async () => {
    const s = await signUp(uniqueEmail('exp'));
    await prisma.tenantRefreshToken.updateMany({
      where: { tenantUserId: s.user.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const res = await refresh(s.refreshToken);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('REFRESH_TOKEN_EXPIRED');
  });

  // ---------- sign-out ----------

  it('sign-out revokes the presented refresh token and is idempotent', async () => {
    const s = await signUp(uniqueEmail('so'));

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-out',
      payload: { refreshToken: s.refreshToken },
    });
    expect(out.statusCode).toBe(200);
    expect((out.json().data as { signedOut: boolean }).signedOut).toBe(true);

    // The refresh is dead — but as a REVOKED token, not a reused one. The
    // operator signed this device out themselves; replaying its token is the
    // device not having noticed, not an attacker holding a spent link in the
    // chain (which is `REFRESH_TOKEN_REUSED`, and does cascade).
    const after = await refresh(s.refreshToken);
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('REFRESH_TOKEN_REVOKED');

    // Calling it twice must not throw.
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-out',
      payload: { refreshToken: s.refreshToken },
    });
    expect(again.statusCode).toBe(200);
  });

  it('sign-out-everywhere revokes every device, and reports how many', async () => {
    const email = uniqueEmail('everywhere');
    const first = await signUp(email);
    const second = await signIn(email);
    const third = await signIn(email);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-out-everywhere',
      headers: { authorization: `Bearer ${third.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { revokedCount: number }).revokedCount).toBe(3);

    for (const session of [first, second, third]) {
      expect((await refresh(session.refreshToken)).statusCode).toBe(401);
    }
  });

  // ---------- session list ----------

  it('sessions lists live sessions and DELETE revokes exactly one', async () => {
    const email = uniqueEmail('sess');
    const a = await signUp(email);
    const b = await signIn(email);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/sessions',
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    const listed = list.json().data as {
      items: Array<{ id: string; createdAt: string }>;
      page: { total: number; hasMore: boolean };
    };
    const sessions = listed.items;
    expect(sessions).toHaveLength(2);
    expect(listed.page).toMatchObject({ total: 2, hasMore: false });

    // Revoke the oldest (the sign-up session), keep the newest.
    const oldest = sessions[sessions.length - 1]!;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/auth/sessions/${oldest.id}`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(del.statusCode).toBe(200);

    const remaining = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/auth/sessions',
        headers: { authorization: `Bearer ${b.accessToken}` },
      })
    ).json().data as { items: Array<{ id: string }>; page: { total: number } };
    expect(remaining.items).toHaveLength(1);
    // The revoked row is gone from the count too, not just from the window.
    expect(remaining.page.total).toBe(1);
    expect(remaining.items[0]!.id).not.toBe(oldest.id);

    // The kept session still refreshes...
    expect((await refresh(b.refreshToken)).statusCode).toBe(200);
    // ...and the revoked one does not, as a deliberate revocation rather than
    // reuse — so it does not take the survivor with it. See the next test.
    const dead = await refresh(a.refreshToken);
    expect(dead.statusCode).toBe(401);
    expect(dead.json().error.code).toBe('REFRESH_TOKEN_REVOKED');
  });

  it('revoking one device signs out only that device, even after it replays its token', async () => {
    const email = uniqueEmail('cascade');
    const revokedDevice = await signUp(email);
    const keptDevice = await signIn(email);

    const sessions = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/auth/sessions',
        headers: { authorization: `Bearer ${keptDevice.accessToken}` },
      })
    ).json().data as { items: Array<{ id: string }> };
    const oldest = sessions.items[sessions.items.length - 1]!;
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/auth/sessions/${oldest.id}`,
      headers: { authorization: `Bearer ${keptDevice.accessToken}` },
    });

    // The revoked device does not know it was revoked; its next scheduled
    // refresh replays a now-revoked token. That used to read as chain
    // compromise and revoke EVERY token for the operator — including the
    // session they deliberately kept, which is the opposite of what "revoke
    // this device" says. `refresh` now separates the two histories a revoked
    // token can have (see the `replacedById` branch in tenant-auth.service):
    // a DELIBERATE revocation is not evidence of an attacker.
    const replay = await refresh(revokedDevice.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('REFRESH_TOKEN_REVOKED');

    // The kept session still works, and still rotates.
    const kept = await refresh(keptDevice.refreshToken);
    expect(kept.statusCode).toBe(200);
    expect(
      await prisma.tenantRefreshToken.count({
        where: { tenantUserId: revokedDevice.user.id, revokedAt: null },
      }),
    ).toBe(1);
  });

  it('replaying a ROTATED token is still chain compromise and revokes everything', async () => {
    // The other history a revoked token can have, and the one reuse-detection
    // exists for: the token was spent by a rotation, so a second presentation
    // means someone else holds it.
    const email = uniqueEmail('rotated-reuse');
    const first = await signUp(email);
    await signIn(email); // a second live session, to prove the cascade reaches it

    const rotated = await refresh(first.refreshToken);
    expect(rotated.statusCode).toBe(200);

    const replay = await refresh(first.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(
      await prisma.tenantRefreshToken.count({
        where: { tenantUserId: first.user.id, revokedAt: null },
      }),
    ).toBe(0);
  });

  it('an operator cannot revoke another operator\'s session', async () => {
    const victim = await signUp(uniqueEmail('victim'));
    const attacker = await signUp(uniqueEmail('attacker'));

    const victimSessions = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/auth/sessions',
        headers: { authorization: `Bearer ${victim.accessToken}` },
      })
    ).json().data as { items: Array<{ id: string }> };

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/auth/sessions/${victimSessions.items[0]!.id}`,
      headers: { authorization: `Bearer ${attacker.accessToken}` },
    });
    // Whatever the shape of the refusal, the victim's session must survive it.
    expect((await refresh(victim.refreshToken)).statusCode).toBe(200);
    expect(res.statusCode).toBeLessThan(500);
  });

  // ---------- password ----------

  it('forgot-password → reset-password rotates the credential and kills sessions', async () => {
    const email = uniqueEmail('reset');
    const s = await signUp(email);

    const forgot = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/forgot-password',
      payload: { email },
    });
    expect(forgot.statusCode).toBe(200);
    // NODE_ENV=test echoes the raw token so the flow is drivable end to end.
    const { resetToken } = forgot.json().data as { resetToken: string | null };
    expect(resetToken).toBeTruthy();

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/reset-password',
      payload: { token: resetToken, newPassword: 'brand-new-password' },
    });
    expect(reset.statusCode).toBe(200);

    // Old credential rejected, new one accepted.
    const oldPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-in',
      payload: { email, password: 'pw-one-two-three' },
    });
    expect(oldPassword.statusCode).toBe(401);
    await signIn(email, 'brand-new-password');

    // The session that existed before the reset is gone.
    expect((await refresh(s.refreshToken)).statusCode).toBe(401);
  });

  it('a reset token is single-use', async () => {
    const email = uniqueEmail('single');
    await signUp(email);
    const { resetToken } = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/forgot-password',
        payload: { email },
      })
    ).json().data as { resetToken: string };

    const body = { token: resetToken, newPassword: 'first-new-password' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/tenant/auth/reset-password', payload: body })).statusCode).toBe(200);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/reset-password',
      payload: { token: resetToken, newPassword: 'second-new-password' },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('PASSWORD_RESET_TOKEN_USED');
  });

  it('forgot-password for an unknown email answers the same as a known one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/forgot-password',
      payload: { email: uniqueEmail('nobody') },
    });
    // No enumeration oracle: 200 either way, and nothing that reveals the miss.
    //
    // `delivered` is asserted because it is the field that *did* reveal it —
    // this test checked only `resetToken` while the body next to it answered
    // `false` for a miss and `true` for a hit. See
    // test/auth-hardening-operator.test.ts for the both-sides comparison.
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { delivered: boolean; resetToken: string | null };
    expect(data.resetToken).toBeNull();
    expect(data.delivered).toBe(true);
  });

  it('change-password requires the current one and revokes the other sessions', async () => {
    const email = uniqueEmail('change');
    const other = await signUp(email);
    const current = await signIn(email);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/change-password',
      headers: { authorization: `Bearer ${current.accessToken}` },
      payload: { currentPassword: 'not-the-password', newPassword: 'a-brand-new-one' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/change-password',
      headers: { authorization: `Bearer ${current.accessToken}` },
      payload: { currentPassword: 'pw-one-two-three', newPassword: 'a-brand-new-one' },
    });
    expect(ok.statusCode).toBe(200);

    await signIn(email, 'a-brand-new-one');
    // The session that was NOT used to change the password is revoked.
    expect((await refresh(other.refreshToken)).statusCode).toBe(401);
  });

  it('change-password refuses a new password under the minimum length', async () => {
    const s = await signUp(uniqueEmail('short'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/change-password',
      headers: { authorization: `Bearer ${s.accessToken}` },
      payload: { currentPassword: 'pw-one-two-three', newPassword: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ---------- the session guard itself ----------

  it('a garbage bearer token is TENANT_SESSION_INVALID; no header is TENANT_SESSION_MISSING', async () => {
    const invalid = await me('not.a.jwt');
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().error.code).toBe('TENANT_SESSION_INVALID');

    const missing = await app.inject({ method: 'GET', url: '/api/v1/tenant/auth/me' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe('TENANT_SESSION_MISSING');
  });

  it('a session whose operator account was deleted is TENANT_SESSION_INVALID', async () => {
    const s = await signUp(uniqueEmail('ghost'));
    expect((await me(s.accessToken)).statusCode).toBe(200);

    await prisma.tenantUser.delete({ where: { id: s.user.id } });

    // The JWT still verifies — the DB re-check is what closes the door.
    const res = await me(s.accessToken);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('TENANT_SESSION_INVALID');
  });
});
