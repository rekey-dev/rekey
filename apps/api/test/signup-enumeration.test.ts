/**
 * What sign-up tells a browser about an address.
 *
 * `EMAIL_ALREADY_EXISTS` answers "does this address have an account" for
 * anyone holding the publishable key. Where a new sign-up gets no session
 * anyway (`requireEmailVerification`), a taken address now gets the very same
 * refusal and the owner is told by mail. Where sign-up hands out a session the
 * 409 stays, because a live session cannot be imitated, and the number of
 * sign-ups one address may attempt in an hour is bounded instead.
 *
 * The limits are the real ones: REKEY_TEST_ENFORCE_RATE_LIMITS=1, as in
 * rate-limit-keying.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const PROXY = '10.77.0.10';
const PASSWORD = 'pw-one-two-three';
const HOURLY_EMAIL_CAP = 5;

describe('Sign-up and account enumeration', () => {
  let app: FastifyInstance;
  let operatorToken: string;
  let applicationId: string;
  let secretKey: string;
  let publishableKey: string;
  let ipCounter = 0;
  const previous = {
    enforce: process.env.REKEY_TEST_ENFORCE_RATE_LIMITS,
    trust: process.env.TRUSTED_PROXIES,
  };

  beforeAll(async () => {
    process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = '1';
    process.env.TRUSTED_PROXIES = PROXY;
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    if (previous.enforce === undefined) delete process.env.REKEY_TEST_ENFORCE_RATE_LIMITS;
    else process.env.REKEY_TEST_ENFORCE_RATE_LIMITS = previous.enforce;
    if (previous.trust === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = previous.trust;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const newIp = (): string => {
    ipCounter += 1;
    return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
  };

  function call(
    url: string,
    payload: unknown,
    headers: Record<string, string>,
    ip = newIp(),
    method: 'POST' | 'PATCH' = 'POST',
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method,
      url: `/api/v1${url}`,
      remoteAddress: PROXY,
      headers: { 'x-forwarded-for': ip, ...headers },
      payload: payload as never,
    });
  }
  const pk = (): Record<string, string> => ({ authorization: `Bearer ${publishableKey}` });
  const sk = (): Record<string, string> => ({ authorization: `Bearer ${secretKey}` });
  const op = (): Record<string, string> => ({ authorization: `Bearer ${operatorToken}` });
  const signUp = (email: string, headers: Record<string, string>, ip?: string): Promise<LightMyRequestResponse> =>
    call('/auth/sign-up', { email, password: PASSWORD }, headers, ip);
  const setAuthConfig = async (patch: Record<string, unknown>): Promise<void> => {
    const res = await call(`/tenant/applications/${applicationId}/auth-config`, patch, op(), newIp(), 'PATCH');
    expect(res.statusCode, res.body).toBe(200);
  };

  beforeEach(async () => {
    const slug = `enum-${Math.random().toString(36).slice(2, 8)}`;
    operatorToken = await call(
      '/tenant/auth/sign-up',
      { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      {},
    ).then((r) => (r.json().data as { accessToken: string }).accessToken);
    applicationId = await call('/tenant/applications/', { name: slug, slug }, op()).then(
      (r) => (r.json().data as { id: string }).id,
    );
    secretKey = await call(`/tenant/applications/${applicationId}/api-keys`, { name: 'k', mode: 'live' }, op()).then(
      (r) => (r.json().data as { rawKey: string }).rawKey,
    );
    publishableKey = await prisma.application
      .findUniqueOrThrow({ where: { id: applicationId }, select: { publicKey: true } })
      .then((a) => a.publicKey);
    await setAuthConfig({ appUrl: 'https://app.example.com', welcomeEmail: 'off' });
  });

  /** A response as its caller sees it, with the per-request id blanked. */
  const visible = (res: LightMyRequestResponse): { status: number; body: string; headers: string[]; type: unknown } => ({
    status: res.statusCode,
    body: res.body.replace(/"requestId":"[^"]+"/, '"requestId":"-"'),
    headers: Object.keys(res.headers)
      .filter((h) => !['date', 'x-request-id', 'x-ratelimit-reset', 'x-ratelimit-remaining', 'content-length'].includes(h))
      .sort(),
    type: res.headers['content-type'],
  });

  const settle = (ms = 200): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const mails = (spy: { mock: { calls: unknown[][] } }, to: string): string[] =>
    spy.mock.calls.map((c) => c[0] as { to: string; eventKey: string }).filter((m) => m.to === to).map((m) => m.eventKey);

  describe('an Application that requires a verified address', () => {
    beforeEach(async () => {
      await setAuthConfig({ requireEmailVerification: true });
    });

    async function existing(kind: 'verified' | 'unverified' | 'banned'): Promise<string> {
      const email = `${kind}-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const created = await call('/auth/sign-up', { email, password: PASSWORD, emailVerified: kind !== 'unverified' }, sk());
      expect(created.statusCode === 201 || created.statusCode === 403, created.body).toBe(true);
      if (kind === 'banned') {
        await prisma.endUser.updateMany({ where: { applicationId, email }, data: { bannedAt: new Date() } });
      }
      await settle();
      return email;
    }

    it.each(['verified', 'unverified', 'banned'] as const)(
      'a browser sign-up with a %s existing address is answered exactly like a new one',
      async (kind) => {
        const taken = await existing(kind);
        const fresh = await signUp(`fresh-${Math.random().toString(36).slice(2, 8)}@example.com`, pk());
        const again = await signUp(taken, pk());
        expect(fresh.statusCode).toBe(403);
        expect(fresh.json().error.code).toBe('EMAIL_NOT_VERIFIED');
        expect(visible(again)).toEqual(visible(fresh));
        expect(again.body).not.toContain('EMAIL_ALREADY_EXISTS');
      },
    );

    it('mails a confirmed owner that they already have an account', async () => {
      const taken = await existing('verified');
      const dispatch = vi.spyOn(emailService, 'dispatch');
      await signUp(taken, pk());
      await vi.waitFor(() => expect(mails(dispatch, taken)).toEqual(['signup_existing_account']));
    });

    it('mails an unconfirmed address a reset link, never another verification link', async () => {
      const taken = await existing('unverified');
      const dispatch = vi.spyOn(emailService, 'dispatch');
      await signUp(taken, pk());
      await vi.waitFor(() => expect(mails(dispatch, taken)).toEqual(['signup_finish_setup']));
      const sent = dispatch.mock.calls.map((c) => c[0] as { variables: { resetUrl?: string } })[0]!;
      const token = new URL(sent.variables.resetUrl!).searchParams.get('token')!;
      const reset = await call('/auth/reset-password', { token, newPassword: 'owner-pw-one-two-three' }, pk());
      expect(reset.statusCode, reset.body).toBe(200);
      const signIn = await call('/auth/sign-in', { email: taken, password: 'owner-pw-one-two-three' }, pk());
      expect(signIn.statusCode, 'the link confirms the address and lets the owner in').toBe(200);
      expect((await call('/auth/sign-in', { email: taken, password: PASSWORD }, pk())).statusCode).toBe(401);
    });

    it('mails a banned address nothing', async () => {
      const taken = await existing('banned');
      const dispatch = vi.spyOn(emailService, 'dispatch');
      await signUp(taken, pk());
      await settle();
      expect(mails(dispatch, taken)).toEqual([]);
    });

    it('the owner mail is counted against the per-recipient cap', async () => {
      const taken = await existing('verified');
      const dispatch = vi.spyOn(emailService, 'dispatch');
      const answers: number[] = [];
      for (let i = 0; i < HOURLY_EMAIL_CAP + 3; i++) answers.push((await signUp(taken, pk())).statusCode);
      await vi.waitFor(() => expect(mails(dispatch, taken)).toHaveLength(HOURLY_EMAIL_CAP));
      await settle();
      expect(mails(dispatch, taken)).toHaveLength(HOURLY_EMAIL_CAP);
      expect(new Set(answers)).toEqual(new Set([403]));
    });

    it('a secret key is still told the address is taken', async () => {
      const taken = await existing('verified');
      const res = await signUp(taken, sk());
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('EMAIL_ALREADY_EXISTS');
    });
  });

  describe('an Application that signs a new account straight in', () => {
    it('keeps the 409 for a browser and for a secret key', async () => {
      const taken = `taken-${Math.random().toString(36).slice(2, 8)}@example.com`;
      expect((await signUp(taken, pk())).statusCode).toBe(201);
      for (const key of [pk(), sk()]) {
        const res = await signUp(taken, key);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('EMAIL_ALREADY_EXISTS');
      }
    });
  });
});
