/**
 * Passkey enrollment from a browser, behind a step-up.
 *
 * The threat: a passkey BYPASSES the MFA challenge at sign-in, and neither
 * change-password nor sign-out-everywhere removes an enrolled one. So a stolen
 * access token that can enroll a passkey buys persistent account takeover the
 * victim cannot revoke by any normal means.
 *
 * Enrollment used to be secret-key-only for exactly that reason. That was the safe
 * holding position, not a fix: it made the flow unreachable from a browser-only app
 * while doing nothing about a stolen token on a server-side one. The control is now
 * a step-up — the caller re-proves identity with something the token does not carry.
 *
 * These tests pin the property that matters: **a valid access token alone is not
 * enough.**
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const PASSWORD = 'pw-one-two-three';

describe('passkey enrollment step-up', () => {
  let app: FastifyInstance;
  let publicKey: string;
  let liveKey: string;
  let userToken: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const slug = `su-${Math.random().toString(36).slice(2, 8)}`;
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: slug, ownerEmail: `op-${slug}@example.com` },
      })
      .then((r) => r.json().data as { id: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: slug, slug },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    publicKey = application.publicKey;
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    userToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${publicKey}` },
        payload: { email: `eu-${slug}@example.com`, password: PASSWORD },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
  });

  const start = (key: string, body?: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/register/start',
      headers: { authorization: `Bearer ${key}`, 'x-rekey-user-token': userToken },
      ...(body !== undefined && { payload: body }),
    });

  it('a stolen access token alone cannot start enrollment', async () => {
    // THE test. Everything else here is detail.
    const res = await start(publicKey, {});
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
  });

  it('a wrong password is refused', async () => {
    const res = await start(publicKey, { password: 'not-the-password' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
  });

  it('the correct password gets a browser through to the ceremony', async () => {
    const res = await start(publicKey, { password: PASSWORD });
    // No WebAuthn config on this app, so the ceremony refuses on CONFIG — which
    // proves the step-up passed and we reached the handler.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('WEBAUTHN_NOT_CONFIGURED');
  });

  it('a secret-key caller is exempt, with no body at all', async () => {
    // The published SDK sends no body here. Fastify validates a missing body
    // against the schema unless normalised, which is what broke disableMfa once.
    const res = await start(liveKey);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('WEBAUTHN_NOT_CONFIGURED');
  });

  it('an account with no password and no MFA is told why it cannot step up', async () => {
    // OAuth-only user: the access token is its ONLY credential, so no challenge we
    // could issue would tell the owner apart from someone holding a stolen token.
    // Refusing beats waving it through — waving it through IS the takeover.
    const { assertStepUp } = await import('../src/lib/step-up.js');
    const application = await prisma.application.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
    });
    const passwordless = await prisma.endUser.create({
      data: {
        applicationId: application.id,
        email: `oauthonly-${Math.random().toString(36).slice(2, 8)}@example.com`,
        passwordHash: null,
      },
    });

    await expect(
      assertStepUp({
        endUserId: passwordless.id,
        action: 'enroll a passkey',
        proof: { password: 'anything' },
        verifyMfaCode: async () => false,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'STEP_UP_UNAVAILABLE' });
  });

  it('a current MFA code is accepted as proof, not just the password', async () => {
    const { assertStepUp } = await import('../src/lib/step-up.js');
    const application = await prisma.application.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
    });
    const user = await prisma.endUser.create({
      data: {
        applicationId: application.id,
        email: `mfa-${Math.random().toString(36).slice(2, 8)}@example.com`,
        passwordHash: null,
      },
    });
    await prisma.mfaCredential.create({
      data: {
        endUserId: user.id,
        secretCiphertext: 'stub',
        backupCodesCiphertext: 'stub',
        enrolledAt: new Date(),
      },
    });

    // Resolves, i.e. does not throw: the verifier said the code is good.
    await expect(
      assertStepUp({
        endUserId: user.id,
        action: 'enroll a passkey',
        proof: { code: '123456' },
        verifyMfaCode: async () => true,
      }),
    ).resolves.toBeUndefined();

    // And a bad code is still refused, so the verifier is actually consulted.
    await expect(
      assertStepUp({
        endUserId: user.id,
        action: 'enroll a passkey',
        proof: { code: '000000' },
        verifyMfaCode: async () => false,
      }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'STEP_UP_REQUIRED' });
  });
});
