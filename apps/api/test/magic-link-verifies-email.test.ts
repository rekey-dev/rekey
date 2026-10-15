/**
 * Signing in by magic link proves the mailbox, so it marks the address
 * verified. That makes the verified-email gate satisfiable by magic link, not
 * bypassable by it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { oidcApplicationWorld } from './oidc-application-world.js';

operatorsConfirmTheirEmail();

describe('magic-link sign-in records the proof it collected', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const { bootstrap, signUp, signIn, setAuthConfig } = oidcApplicationWorld(() => app);

  it('an existing unverified password user comes out verified', async () => {
    const fx = await bootstrap({ methods: ['password', 'magic_link'] });
    const created = await signUp(fx, 'magic@example.com');
    expect(created.statusCode).toBe(201);
    const before = await prisma.endUser.findFirstOrThrow({
      where: { applicationId: fx.appId, email: 'magic@example.com' },
    });
    expect(before.emailVerified).toBe(false);

    const { magicLinkToken } = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/request',
        headers: { authorization: `Bearer ${fx.liveKey}` },
        payload: { email: 'magic@example.com' },
      })
      .then((r) => r.json().data as { magicLinkToken: string });
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      headers: { authorization: `Bearer ${fx.liveKey}` },
      payload: { token: magicLinkToken },
    });
    expect(verified.statusCode).toBe(200);

    const after = await prisma.endUser.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.emailVerified).toBe(true);
  });

  it('so the gate is not bypassable by magic link, it is satisfiable by it', async () => {
    const fx = await bootstrap({ methods: ['password', 'magic_link'] });
    expect((await signUp(fx, 'gate@example.com')).statusCode).toBe(201);
    expect((await setAuthConfig(fx, { requireEmailVerification: true })).statusCode).toBe(200);
    // Password sign-in is refused while the address is unconfirmed…
    expect((await signIn(fx, 'gate@example.com')).statusCode).toBe(403);

    const { magicLinkToken } = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/request',
        headers: { authorization: `Bearer ${fx.liveKey}` },
        payload: { email: 'gate@example.com' },
      })
      .then((r) => r.json().data as { magicLinkToken: string });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/magic-link/verify',
          headers: { authorization: `Bearer ${fx.liveKey}` },
          payload: { token: magicLinkToken },
        })
      ).statusCode,
    ).toBe(200);

    // …and afterwards the address is on record as confirmed, because the
    // proof was kept rather than spent on one session and thrown away.
    const after = await prisma.endUser.findFirstOrThrow({
      where: { applicationId: fx.appId, email: 'gate@example.com' },
    });
    expect(after.emailVerified).toBe(true);
    // The password set before anyone had confirmed the address went with
    // the proof: whoever registered it may not have been the mailbox owner.
    expect((await signIn(fx, 'gate@example.com')).statusCode).toBe(401);
  });
});
