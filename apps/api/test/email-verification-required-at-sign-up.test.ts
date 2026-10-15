/**
 * With `requireEmailVerification` on, sign-up creates the account and hands
 * back no session, the verification mail goes out whatever the auto-send switch
 * says, and refresh re-checks so turning the switch on ends unverified sessions.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { oidcApplicationWorld } from './oidc-application-world.js';

operatorsConfirmTheirEmail();

describe('requireEmailVerification covers sign-up, not just sign-in', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const { bootstrap, signUp, setAuthConfig } = oidcApplicationWorld(() => app);

  it('sign-up hands back NO session, and the account is still created', async () => {
    const fx = await bootstrap({ requireEmailVerification: true });
    const res = await signUp(fx, 'fresh@example.com');

    // Used to be 201 with a working access + refresh token.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    const body = res.json();
    expect(body.data).toBeUndefined();

    // The account exists, the refusal is of the session, not the sign-up,
    // and no refresh chain was opened.
    const user = await prisma.endUser.findFirstOrThrow({
      where: { applicationId: fx.appId, email: 'fresh@example.com' },
    });
    expect(user.emailVerified).toBe(false);
    expect(await prisma.refreshToken.count({ where: { endUserId: user.id } })).toBe(0);
  });

  it('the verification mail goes out even with the auto-send switch off', async () => {
    // Otherwise the two settings together mint accounts nobody can reach:
    // no session to re-send from, and no link ever posted. (The first half of
    // that is no longer true, POST /auth/resend-verification needs no
    // session, but a link the user never received is still the wrong
    // default, so this invariant stands.)
    //
    // `appUrl` because a send with no resolvable link is skipped outright
    // rather than mailing a button-less confirmation; that behaviour has its
    // own coverage in email-verification-config.test.ts.
    const fx = await bootstrap({
      requireEmailVerification: true,
      sendVerificationEmailOnSignUp: false,
      appUrl: 'https://app.example.com',
    });
    expect((await signUp(fx, 'stranded@example.com')).statusCode).toBe(403);

    const deadline = Date.now() + 4000;
    for (;;) {
      const count = await prisma.emailVerificationToken.count({
        where: { applicationId: fx.appId },
      });
      if (count > 0 || Date.now() > deadline) {
        expect(count).toBe(1);
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  });

  it('refresh re-checks, so flipping the switch on ends live unverified sessions', async () => {
    const fx = await bootstrap();
    const created = await signUp(fx, 'grandfathered@example.com');
    expect(created.statusCode).toBe(201);
    const { refreshToken } = created.json().data as { refreshToken: string };

    expect((await setAuthConfig(fx, { requireEmailVerification: true })).statusCode).toBe(200);

    // Used to keep renewing for the full 30-day refresh lifetime.
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${fx.liveKey}` },
      payload: { refreshToken },
    });
    expect(refreshed.statusCode).toBe(403);
    expect(refreshed.json().error.code).toBe('EMAIL_NOT_VERIFIED');
  });

});
