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
 *
 * Every fixture below sets `appUrl`, because a send with no resolvable link is
 * now skipped outright — see the "no link, no mail" block at the bottom, which
 * is the case that needs the default (`redirectUrls: []`, no `appUrl`, no
 * `DEFAULT_APP_URL`) and asserts on it deliberately.
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
  let publishableKey: string;
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
    publishableKey = await prisma.application
      .findUniqueOrThrow({ where: { id: applicationId }, select: { publicKey: true } })
      .then((a) => a.publicKey);
    euEmail = `eu-${slug}@example.com`;
    // A brand-new Application has `redirectUrls: []` and no `appUrl`, which
    // means no verification link resolves and the send is skipped. Everything
    // in this file except the last block is about the two switches, not about
    // URL resolution, so give the fixture a link it can build.
    await setAuthConfig({ appUrl: 'https://app.example.com' });
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

  // ---------- No link, no mail ----------

  /**
   * The composed defect: `sendVerificationEmailOnSignUp` is on by default, and
   * a link that cannot resolve must not render (#275) — so an Application with
   * no `appUrl`, no usable `redirectUrls` origin and no `DEFAULT_APP_URL`
   * mailed every new user "click the button below to confirm this is your
   * email address" with no button in it. With `requireEmailVerification` also
   * on, that mail was the only route into the account.
   *
   * `clearAppUrl()` puts the fixture back to how a brand-new Application
   * actually arrives, which is what made this reachable by default.
   */
  describe('a verification link that cannot be built', () => {
    const clearAppUrl = () => setAuthConfig({ appUrl: null, redirectUrls: [] });

    it('sign-up skips the verification mail entirely rather than sending a button-less one', async () => {
      expect((await clearAppUrl()).statusCode).toBe(200);
      expect((await signUp()).statusCode).toBe(201);

      // The welcome mail still goes — its body reads without its CTA.
      expect(await waitForEmailLogs(applicationId, 'welcome', 1)).toHaveLength(1);
      await settle();
      expect(await waitForEmailLogs(applicationId, 'email_verification', 1, 0)).toHaveLength(0);
      // And no token was minted for a mail nobody sent.
      expect(await prisma.emailVerificationToken.count({ where: { applicationId } })).toBe(0);
    });

    it('the skip is recorded, so it is a visible refusal and not a silent drop', async () => {
      await clearAppUrl();
      await signUp();

      const deadline = Date.now() + 4000;
      let events: Array<{ metadata: unknown }> = [];
      for (;;) {
        events = await prisma.securityEvent.findMany({
          where: { applicationId, type: 'auth.email_delivery_failed' },
          select: { metadata: true },
        });
        if (events.length > 0 || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(events).toHaveLength(1);
      const metadata = events[0]!.metadata as { eventKey: string; reason: string };
      expect(metadata.eventKey).toBe('email_verification');
      // The operator has to be told which setting fixes it.
      expect(metadata.reason).toMatch(/appUrl/);
    });

    it('an allowlisted redirect URL is enough to bring the send back', async () => {
      await clearAppUrl();
      expect(
        (await setAuthConfig({ redirectUrls: ['https://app.example.com/callback'] })).statusCode,
      ).toBe(200);
      expect((await signUp()).statusCode).toBe(201);

      expect(await waitForEmailLogs(applicationId, 'email_verification', 1)).toHaveLength(1);
    });

    it('the explicit /auth/send-verification keeps working — it hands back a token, not a link', async () => {
      // Deliberately NOT gated on a resolvable URL: that route's documented
      // no-transport contract is "here is the raw token, deliver it yourself",
      // and an integrator using it never depended on our template.
      const accessToken = await signUp().then(
        (r) => (r.json().data as { accessToken: string }).accessToken,
      );
      await clearAppUrl();

      const sent = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/send-verification',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': accessToken },
        payload: {},
      });
      expect(sent.statusCode).toBe(200);
      expect((sent.json().data as { verificationToken: string | null }).verificationToken).toBeTruthy();
    });
  });

  // ---------- The sessionless re-send ----------

  /**
   * `requireEmailVerification` denies the session that `/auth/send-verification`
   * demands, so a user whose mail never arrived had no self-service route back
   * into their own account. Opening a sessionless re-send is an enumeration and
   * mail-bombing surface, so this mirrors `/auth/forgot-password` exactly: one
   * constant body for a publishable caller, the real outcome for a secret one,
   * no status-code difference, and no `EMAIL_ALREADY_VERIFIED`.
   */
  describe('POST /auth/resend-verification', () => {
    const resend = (email: string, key: string, body: Record<string, unknown> = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/resend-verification',
        headers: { authorization: `Bearer ${key}` },
        payload: { email, ...body },
      });

    it('mints a usable link for an unverified address with no session in sight', async () => {
      await signUp();
      await setAuthConfig({ requireEmailVerification: true });
      // The gate is on, so there is genuinely no session to call the
      // authenticated route with.
      expect((await signIn()).statusCode).toBe(403);

      const res = await resend(euEmail, liveKey);
      expect(res.statusCode).toBe(200);
      // No transport in the suite, so a SECRET caller gets the raw token —
      // same contract /auth/forgot-password uses.
      const { verificationToken } = res.json().data as { verificationToken: string | null };
      expect(verificationToken).toBeTruthy();

      const consumed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/verify-email',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { token: verificationToken },
      });
      expect(consumed.statusCode).toBe(200);
      // The whole point: the user is back in.
      expect((await signIn()).statusCode).toBe(200);
    });

    it('an unknown address is a 200 with the same shape, and mints nothing', async () => {
      const res = await resend('nobody-at-all@example.com', liveKey);
      expect(res.statusCode).toBe(200);
      const data = res.json().data as { emailSent: boolean; verificationToken: string | null };
      expect(data.verificationToken).toBeNull();
      expect(await prisma.emailVerificationToken.count({ where: { applicationId } })).toBe(0);
      await settle();
      expect(await waitForEmailLogs(applicationId, 'email_verification', 1, 0)).toHaveLength(0);
    });

    it('an already-verified address is a 200, not EMAIL_ALREADY_VERIFIED', async () => {
      // The authenticated route answers 400 there and can afford to: its
      // caller already proved who they are. Here that 400 would answer "does
      // this address have a confirmed account" for anyone who asks.
      const accessToken = await signUp().then(
        (r) => (r.json().data as { accessToken: string }).accessToken,
      );
      await verifyAddress(accessToken);

      const res = await resend(euEmail, liveKey);
      expect(res.statusCode).toBe(200);
      expect(res.json().error).toBeUndefined();
      expect((res.json().data as { verificationToken: string | null }).verificationToken).toBeNull();
    });

    it('a publishable caller cannot tell unknown, verified and genuinely-sent apart', async () => {
      await signUp();

      const unverified = await resend(euEmail, publishableKey);
      const unknown = await resend('nobody-at-all@example.com', publishableKey);
      expect(unverified.statusCode).toBe(200);
      expect(unknown.statusCode).toBe(200);
      // Byte-identical, and never carrying a token to a key that ships in a
      // browser bundle.
      expect(unverified.json()).toEqual(unknown.json());
      expect((unverified.json().data as { verificationToken: unknown }).verificationToken).toBeNull();

      // …and the same body once the address is confirmed.
      const accessToken = await signIn().then(
        (r) => (r.json().data as { accessToken: string }).accessToken,
      );
      await verifyAddress(accessToken);
      const verified = await resend(euEmail, publishableKey);
      expect(verified.json()).toEqual(unknown.json());
    });

    it('sends nothing when no verification link can be built', async () => {
      await signUp();
      await setAuthConfig({ appUrl: null, redirectUrls: [] });
      // Drop the token the sign-up minted so the count below is unambiguous.
      await prisma.emailVerificationToken.deleteMany({ where: { applicationId } });

      const res = await resend(euEmail, liveKey);
      expect(res.statusCode).toBe(200);
      expect((res.json().data as { verificationToken: string | null }).verificationToken).toBeNull();
      expect(await prisma.emailVerificationToken.count({ where: { applicationId } })).toBe(0);
    });

    it('a caller-supplied verifyUrl satisfies that — once its origin is registered', async () => {
      // This used to pass with NOTHING registered, which was the hole: the
      // route accepts a publishable key, so anyone could have us mail a live
      // token to a domain they chose. The URL must now be on an origin the
      // Application declared.
      await signUp();
      await setAuthConfig({ appUrl: null, redirectUrls: ['https://elsewhere.example.com/cb'] });
      await prisma.emailVerificationToken.deleteMany({ where: { applicationId } });

      const res = await resend(euEmail, liveKey, {
        verifyUrl: 'https://elsewhere.example.com/confirm?t={token}',
      });
      expect(res.statusCode).toBe(200);
      expect((res.json().data as { verificationToken: string | null }).verificationToken).toBeTruthy();
    });

    it('an unparseable email is a 400 before any of this runs', async () => {
      const res = await resend('not-an-email', liveKey);
      expect(res.statusCode).toBe(400);
    });
  });
});
