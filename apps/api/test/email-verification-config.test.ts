/**
 * Per-Application email-verification configuration.
 *
 *   - `sendVerificationEmailOnSignUp` (default ON) — password sign-up posts
 *     the verification mail *alongside* the welcome one, and a send that goes
 *     nowhere (no transport configured, as in this suite) still leaves the
 *     account created and the token usable.
 *   - `requireEmailVerification` (default OFF) — password sign-in refuses an
 *     unconfirmed address with 403 EMAIL_NOT_VERIFIED rather than a session,
 *     without counting the refusal as a failed password attempt.
 *
 * Both sends are fire-and-forget, so the assertions poll the `email_logs`
 * rows the transport writes for every outcome (`sent` / `no_transport` /
 * `error`) rather than the sign-up response.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { LOGIN_POLICY } from '../src/lib/brute-force.js';

const PASSWORD = 'pw-one-two-three';

/** Poll for email-log rows of one event key — both sends are fire-and-forget. */
async function waitForEmailLogs(
  applicationId: string,
  eventKey: string,
  count: number,
  timeoutMs = 4000,
): Promise<Array<{ status: string; toAddress: string }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.emailLog.findMany({ where: { applicationId, eventKey } });
    if (rows.length >= count || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Settle window for negative assertions ("nothing was sent"). */
async function settle(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('email-verification configuration', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;
  let tenantAccess: string;
  let euEmail: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const slug = `emailver-${Math.random().toString(36).slice(2, 8)}`;
    tenantAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: `App ${slug}`, slug },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    euEmail = `eu-${slug}@example.com`;
  });

  const setAuthConfig = (patch: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: { authorization: `Bearer ${tenantAccess}` },
      payload: patch,
    });

  const signUp = () =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: euEmail, password: PASSWORD },
    });

  const signIn = () =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: euEmail, password: PASSWORD },
    });

  /** Mint a fresh verification token and consume it, as the emailed link would. */
  async function verifyAddress(accessToken: string): Promise<void> {
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/send-verification',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': accessToken },
      payload: {},
    });
    // No transport in the suite, so the raw token comes back to the caller.
    const { verificationToken } = sent.json().data as { verificationToken: string | null };
    expect(verificationToken).toBeTruthy();
    const consumed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { token: verificationToken },
    });
    expect(consumed.statusCode).toBe(200);
  }

  describe('sendVerificationEmailOnSignUp', () => {
    it('default on: sign-up posts the verification mail as well as the welcome one', async () => {
      const created = await signUp();
      expect(created.statusCode).toBe(201);

      const welcome = await waitForEmailLogs(applicationId, 'welcome', 1);
      const verification = await waitForEmailLogs(applicationId, 'email_verification', 1);
      expect(welcome).toHaveLength(1);
      expect(verification).toHaveLength(1);
      expect(verification[0]!.toAddress).toBe(euEmail);
      // No transport is configured here — the send is recorded as
      // `no_transport` and the sign-up succeeded anyway. That degradation is
      // the point: a deployment with no email set up must not lose accounts.
      expect(verification[0]!.status).toBe('no_transport');

      const tokens = await prisma.emailVerificationToken.count({ where: { applicationId } });
      expect(tokens).toBe(1);
    });

    it('off: the welcome mail still goes out, the verification one does not', async () => {
      expect((await setAuthConfig({ sendVerificationEmailOnSignUp: false })).statusCode).toBe(200);
      expect((await signUp()).statusCode).toBe(201);

      expect(await waitForEmailLogs(applicationId, 'welcome', 1)).toHaveLength(1);
      await settle();
      expect(await waitForEmailLogs(applicationId, 'email_verification', 1, 0)).toHaveLength(0);
      expect(await prisma.emailVerificationToken.count({ where: { applicationId } })).toBe(0);
    });

    it('magic-link sign-up sends no verification mail — the link was the proof', async () => {
      await setAuthConfig({ methods: ['password', 'magic_link'] });
      const requested = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/request',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: euEmail },
      });
      const { magicLinkToken } = requested.json().data as { magicLinkToken: string | null };
      const verified = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/verify',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { token: magicLinkToken },
      });
      expect(verified.statusCode).toBe(200);

      expect(await waitForEmailLogs(applicationId, 'welcome', 1)).toHaveLength(1);
      await settle();
      expect(await waitForEmailLogs(applicationId, 'email_verification', 1, 0)).toHaveLength(0);
      const user = await prisma.endUser.findFirstOrThrow({ where: { applicationId } });
      expect(user.emailVerified).toBe(true);
    });
  });

  describe('requireEmailVerification', () => {
    it('default off: an unverified user signs in exactly as before', async () => {
      await signUp();
      const res = await signIn();
      expect(res.statusCode).toBe(200);
      expect((res.json().data as { mfaRequired: boolean }).mfaRequired).toBe(false);
    });

    it('on: an unconfirmed address is refused with EMAIL_NOT_VERIFIED, not INVALID_CREDENTIALS', async () => {
      await signUp();
      await setAuthConfig({ requireEmailVerification: true });

      const res = await signIn();
      expect(res.statusCode).toBe(403);
      const error = res.json().error as { code: string; message: string };
      expect(error.code).toBe('EMAIL_NOT_VERIFIED');
      // The user has to be told to go and look in their inbox — a generic
      // credential error sends them to password reset instead.
      expect(error.message).toMatch(/email/i);
    });

    it('on: a wrong password is still INVALID_CREDENTIALS, verified or not', async () => {
      await signUp();
      await setAuthConfig({ requireEmailVerification: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: euEmail, password: 'not-the-password' },
      });
      expect(res.statusCode).toBe(401);
      expect((res.json().error as { code: string }).code).toBe('INVALID_CREDENTIALS');
    });

    it('on: confirming the address restores sign-in', async () => {
      const accessToken = await signUp().then(
        (r) => (r.json().data as { accessToken: string }).accessToken,
      );
      await setAuthConfig({ requireEmailVerification: true });
      expect((await signIn()).statusCode).toBe(403);

      await verifyAddress(accessToken);
      expect((await signIn()).statusCode).toBe(200);
    });

    it('the refusal does not count toward the brute-force lockout', async () => {
      const accessToken = await signUp().then(
        (r) => (r.json().data as { accessToken: string }).accessToken,
      );
      await setAuthConfig({ requireEmailVerification: true });

      // A user waiting on their verification email retries. Every one of these
      // carries the CORRECT password, so none is a failed attempt — past the
      // lockout threshold they must still be refused for the right reason.
      for (let i = 0; i < LOGIN_POLICY.threshold + 1; i += 1) {
        const res = await signIn();
        expect(res.statusCode).toBe(403);
        expect((res.json().error as { code: string }).code).toBe('EMAIL_NOT_VERIFIED');
      }

      await verifyAddress(accessToken);
      // 200, not 429: the account was never locked.
      expect((await signIn()).statusCode).toBe(200);
    });

    it('on: magic-link sign-in is unaffected', async () => {
      await setAuthConfig({ methods: ['password', 'magic_link'], requireEmailVerification: true });
      const { magicLinkToken } = await app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/magic-link/request',
          headers: { authorization: `Bearer ${liveKey}` },
          payload: { email: euEmail },
        })
        .then((r) => r.json().data as { magicLinkToken: string | null });
      const verified = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/verify',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { token: magicLinkToken },
      });
      expect(verified.statusCode).toBe(200);
    });
  });

  it('both fields round-trip through the auth-config endpoint', async () => {
    const patched = await setAuthConfig({
      sendVerificationEmailOnSignUp: false,
      requireEmailVerification: true,
    });
    expect(patched.statusCode).toBe(200);
    const { authConfig } = patched.json().data as {
      authConfig: { sendVerificationEmailOnSignUp: boolean; requireEmailVerification: boolean };
    };
    expect(authConfig.sendVerificationEmailOnSignUp).toBe(false);
    expect(authConfig.requireEmailVerification).toBe(true);
  });

  it('an application saved before these fields existed keeps the documented defaults', async () => {
    // Simulates a row written by an older release: the two keys are simply
    // absent from the jsonb column.
    const stored = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const legacy = { ...(stored.authConfig as Record<string, unknown>) };
    delete legacy.sendVerificationEmailOnSignUp;
    delete legacy.requireEmailVerification;
    await prisma.application.update({
      where: { id: applicationId },
      data: { authConfig: legacy },
    });

    expect((await signUp()).statusCode).toBe(201);
    // Enforcement stays off (sign-in works), auto-send comes on.
    expect((await signIn()).statusCode).toBe(200);
    expect(await waitForEmailLogs(applicationId, 'email_verification', 1)).toHaveLength(1);
  });
});
