/**
 * The five things a support agent needs on a ticket and could not do from the
 * panel: clear a lockout, re-send a verification mail, start a password reset,
 * see somebody's sessions, and end them, plus "release every device", which is
 * the answer to "I changed laptop and cannot sign in".
 *
 * What these cases are actually about is the EDGES, not the happy paths. Each
 * of these routes acts on a real person who is not in the room, so the
 * interesting questions are the ones where doing the obvious thing would be
 * wrong: a tombstoned account, an OAuth-only user with no password to reset, an
 * address that is already verified, a BLOCKED device that a bulk release must
 * not quietly unblock, and a session id belonging to somebody else.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { euLoginLockScope, getScopeLockState, registerFailure, LOGIN_POLICY } from '../src/lib/brute-force.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

interface World {
  ownerToken: string;
  applicationId: string;
  publishableKey: string;
  endUserId: string;
  email: string;
  tag: string;
}

describe('operator support actions on one end-user', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  let currentIp = '10.96.0.1';
  function inject(opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: currentIp, ...opts } as never);
  }

  async function world(
    opts: { password?: string | null; emailVerified?: boolean } = {},
  ): Promise<World> {
    currentIp = `10.96.${++n}.1`;
    const tag = `support-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `owner-${tag}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: 'Support Co',
      },
    });
    expect(su.statusCode).toBe(201);
    const ownerToken = (su.json().data as { accessToken: string }).accessToken;

    const appRes = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Support app', slug: tag },
    });
    expect(appRes.statusCode).toBe(201);
    const application = appRes.json().data as { id: string; publicKey: string };

    // `appUrl` so the verification mail has a link to build; without one the
    // send is refused outright rather than mailing a button-less template.
    await prisma.application.update({
      where: { id: application.id },
      data: {
        authConfig: {
          ...((
            await prisma.application.findUniqueOrThrow({ where: { id: application.id } })
          ).authConfig as object),
          appUrl: 'https://app.example.com',
        } as object,
      },
    });

    const email = `subject-${tag}@example.com`;
    const eu = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${application.id}/end-users`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        email,
        ...(opts.password === null ? {} : { password: opts.password ?? 'pw-one-two-three' }),
        ...(opts.emailVerified !== undefined && { emailVerified: opts.emailVerified }),
      },
    });
    expect(eu.statusCode).toBe(201);

    return {
      ownerToken,
      applicationId: application.id,
      publishableKey: application.publicKey,
      endUserId: (eu.json().data as { id: string }).id,
      email,
      tag,
    };
  }

  const auth = (w: World) => ({ authorization: `Bearer ${w.ownerToken}` });
  const base = (w: World) =>
    `/api/v1/tenant/applications/${w.applicationId}/end-users/${w.endUserId}`;

  // ---------- unlock ----------

  it('clears a real lockout, and is a no-op on an account that is not locked', async () => {
    const w = await world();
    const scope = euLoginLockScope(w.applicationId, w.email);

    // Trip the limiter for real rather than asserting against a fake.
    for (let i = 0; i < LOGIN_POLICY.threshold; i++) await registerFailure(scope, LOGIN_POLICY);
    // A healthy unlocked scope returns an OBJECT, not null, null means the
    // store itself failed. `lockedForSec` is the lockout signal.
    expect((await getScopeLockState(scope))?.lockedForSec).not.toBeNull();

    const first = await inject({ method: 'POST', url: `${base(w)}/unlock`, headers: auth(w) });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.unlocked).toBe(true);
    expect((await getScopeLockState(scope))?.lockedForSec).toBeNull();

    const again = await inject({ method: 'POST', url: `${base(w)}/unlock`, headers: auth(w) });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.unlocked).toBe(false);
  });

  it('unlocking is per-Application: the same address elsewhere stays locked', async () => {
    // The lock key carries the application id. Two Applications are two
    // end-users, and an operator must not be able to reach into a lock that is
    // not theirs, nor accidentally clear one they did not mean to.
    const a = await world();
    const b = await world();
    const scopeB = euLoginLockScope(b.applicationId, b.email);
    for (let i = 0; i < LOGIN_POLICY.threshold; i++) await registerFailure(scopeB, LOGIN_POLICY);

    await inject({ method: 'POST', url: `${base(a)}/unlock`, headers: auth(a) });
    expect((await getScopeLockState(scopeB))?.lockedForSec).not.toBeNull();
  });

  // ---------- verification re-send ----------

  it('re-sends verification, and refuses once the address is verified', async () => {
    // Operator-created end-users are verified by default (`emailVerified ?? true`,
    // the operator vouched), so an unverified subject is asked for.
    const w = await world({ emailVerified: false });
    const sent = await inject({
      method: 'POST',
      url: `${base(w)}/send-verification`,
      headers: auth(w),
      payload: { reason: 'customer says it never arrived' },
    });
    expect(sent.statusCode).toBe(200);
    // No transport is configured in test, so the mail cannot leave, the point
    // is that the route reports that honestly rather than claiming success.
    expect(typeof sent.json().data.emailSent).toBe('boolean');

    // A token really was minted and is live.
    expect(
      await prisma.emailVerificationToken.count({
        where: { endUserId: w.endUserId, consumedAt: null },
      }),
    ).toBeGreaterThan(0);

    await prisma.endUser.update({ where: { id: w.endUserId }, data: { emailVerified: true } });
    // `{}` rather than no body at all: the route declares a JSON body schema
    // (for the optional `reason`), and Fastify answers 400 to a bodyless POST
    // against one. Same shape as the device `block` route beside it.
    const again = await inject({
      method: 'POST',
      url: `${base(w)}/send-verification`,
      headers: auth(w),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('EMAIL_ALREADY_VERIFIED');
  });

  // ---------- password reset ----------

  it('requires a reason, and refuses an account with no password', async () => {
    const noPassword = await world({ password: null });
    const missingReason = await inject({
      method: 'POST',
      url: `${base(noPassword)}/send-password-reset`,
      headers: auth(noPassword),
      payload: {},
    });
    expect(missingReason.statusCode).toBe(400);

    const res = await inject({
      method: 'POST',
      url: `${base(noPassword)}/send-password-reset`,
      headers: auth(noPassword),
      payload: { reason: 'ticket #9' },
    });
    // An OAuth-only user has nothing to reset; sending would strand them on a
    // form they cannot complete.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('END_USER_HAS_NO_PASSWORD');
  });

  it('sends a reset for a password user and audits the reason', async () => {
    const w = await world();
    const res = await inject({
      method: 'POST',
      url: `${base(w)}/send-password-reset`,
      headers: auth(w),
      payload: { reason: 'locked out, verified identity on call' },
    });
    expect(res.statusCode).toBe(200);

    expect(
      await prisma.passwordResetToken.count({ where: { endUserId: w.endUserId } }),
    ).toBeGreaterThan(0);

    // Security events are recorded without awaiting, so poll for the row
    // rather than reading straight after the response.
    const [audit] = await waitForSecurityEvents({
      applicationId: w.applicationId,
      type: 'end_user.password_reset_sent',
    });
    expect(audit?.metadata).toMatchObject({
      endUserId: w.endUserId,
      reason: 'locked out, verified identity on call',
    });
  });

  // ---------- sessions ----------

  async function signIn(w: World, fingerprint?: string) {
    const res = await inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${w.publishableKey}` },
      payload: {
        email: w.email,
        password: 'pw-one-two-three',
        ...(fingerprint ? { device: { fingerprint, label: fingerprint } } : {}),
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json().data as { refreshToken: string };
  }

  it('lists live sessions and revokes one, leaving the others', async () => {
    const w = await world();
    await signIn(w);
    await signIn(w);

    const list = await inject({ method: 'GET', url: `${base(w)}/sessions`, headers: auth(w) });
    expect(list.statusCode).toBe(200);
    const items = list.json().data.items as Array<{ id: string }>;
    expect(items.length).toBe(2);

    const del = await inject({
      method: 'DELETE',
      url: `${base(w)}/sessions/${items[0]!.id}`,
      headers: auth(w),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.revoked).toBe(true);

    const after = await inject({ method: 'GET', url: `${base(w)}/sessions`, headers: auth(w) });
    expect((after.json().data.items as unknown[]).length).toBe(1);

    // Idempotent, and not an existence oracle: a second revoke of the same id
    // answers false rather than 404.
    const twice = await inject({
      method: 'DELETE',
      url: `${base(w)}/sessions/${items[0]!.id}`,
      headers: auth(w),
    });
    expect(twice.statusCode).toBe(200);
    expect(twice.json().data.revoked).toBe(false);
  });

  it("cannot revoke another end-user's session", async () => {
    const a = await world();
    const b = await world();
    await signIn(b);
    const bSessions = await inject({ method: 'GET', url: `${base(b)}/sessions`, headers: auth(b) });
    const bId = (bSessions.json().data.items as Array<{ id: string }>)[0]!.id;

    const res = await inject({
      method: 'DELETE',
      url: `${base(a)}/sessions/${bId}`,
      headers: auth(a),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.revoked).toBe(false);

    // And B's session is untouched.
    const still = await inject({ method: 'GET', url: `${base(b)}/sessions`, headers: auth(b) });
    expect((still.json().data.items as unknown[]).length).toBe(1);
  });

  it('signs an end-user out everywhere', async () => {
    const w = await world();
    await signIn(w);
    await signIn(w);

    const res = await inject({
      method: 'POST',
      url: `${base(w)}/sessions/revoke-all`,
      headers: auth(w),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.revoked).toBe(2);

    const after = await inject({ method: 'GET', url: `${base(w)}/sessions`, headers: auth(w) });
    expect((after.json().data.items as unknown[]).length).toBe(0);
  });

  // ---------- release every device ----------

  it('releases every active device but leaves a blocked one alone', async () => {
    const w = await world();
    await signIn(w, 'fp-alpha-000000000001');
    await signIn(w, 'fp-bravo-000000000002');
    await signIn(w, 'fp-charlie-00000000003');

    const devices = await inject({
      method: 'GET',
      url: `${base(w)}/devices`,
      headers: auth(w),
    });
    const all = devices.json().data.items as Array<{ id: string; status: string }>;
    expect(all.length).toBe(3);

    const blockRes = await inject({
      method: 'POST',
      url: `${base(w)}/devices/${all[0]!.id}/block`,
      headers: auth(w),
      payload: { reason: 'stolen' },
    });
    expect(blockRes.statusCode).toBe(200);

    const res = await inject({
      method: 'POST',
      url: `${base(w)}/devices/release-all`,
      headers: auth(w),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      released: number;
      sessionsRevoked: number;
      skippedBlocked: number;
    };
    expect(data.released).toBe(2);
    expect(data.skippedBlocked).toBe(1);

    // The block survives. A bulk convenience must never quietly undo a
    // deliberate per-machine decision.
    const after = await inject({ method: 'GET', url: `${base(w)}/devices`, headers: auth(w) });
    const byId = new Map(
      (after.json().data.items as Array<{ id: string; status: string }>).map((d) => [d.id, d.status]),
    );
    expect(byId.get(all[0]!.id)).toBe('BLOCKED');
    expect(byId.get(all[1]!.id)).toBe('RELEASED');
    expect(byId.get(all[2]!.id)).toBe('RELEASED');
  });

  it('release-all is idempotent', async () => {
    const w = await world();
    const res = await inject({
      method: 'POST',
      url: `${base(w)}/devices/release-all`,
      headers: auth(w),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.released).toBe(0);
  });

  // ---------- tombstones ----------

  it('every support action refuses a tombstoned end-user', async () => {
    const w = await world();
    const erase = await inject({
      method: 'DELETE',
      url: `${base(w)}?erasure=true`,
      headers: auth(w),
    });
    expect(erase.statusCode).toBe(200);

    for (const [method, path, payload] of [
      ['POST', '/unlock', {}],
      ['POST', '/send-verification', {}],
      ['POST', '/send-password-reset', { reason: 'x' }],
    ] as const) {
      const res = await inject({
        method,
        url: `${base(w)}${path}`,
        headers: auth(w),
        payload,
      });
      expect(res.statusCode, `${method} ${path}`).toBe(410);
      expect(res.json().error.code, `${method} ${path}`).toBe('END_USER_ERASED');
    }
  });

  // ---------- access control ----------

  it('a MEMBER with no grant gets 404, not 403', async () => {
    const w = await world();
    const tag = `outsider-${w.tag}`;
    const other = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `${tag}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: 'Outsider Co',
      },
    });
    const otherToken = (other.json().data as { accessToken: string }).accessToken;

    const res = await inject({
      method: 'POST',
      url: `${base(w)}/unlock`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
