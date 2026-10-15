/**
 * The per-recipient cap on built-in auth email.
 *
 * The request limits on the sign-in forms count by caller address, so a caller
 * spread over many addresses could have an Application mail one inbox without
 * limit, and `victim+N@` sign-ups did the same with two mails each. The cap
 * counts by the mailbox, and has to do it without telling a browser caller
 * whether the address has an account.
 *
 * Every limiter is neutered under NODE_ENV=test. This file opts back in with
 * REKEY_TEST_ENFORCE_RATE_LIMITS=1, the same switch rate-limit-keying uses, so
 * the cap and the route limits beside it are the real ones.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

const redis = vi.hoisted(() => ({
  client: null as null | { eval: () => Promise<number>; decr: () => Promise<number> },
}));

vi.mock('../src/lib/redis.js', () => ({
  getRedis: () => redis.client,
  closeRedis: async () => undefined,
}));

import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';
import { recipientCapKey } from '../src/modules/email/custom/send-caps.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const PROXY = '10.77.0.10';
const PASSWORD = 'pw-one-two-three';
const HOURLY_CAP = 5;

describe('Per-recipient cap on auth email', () => {
  let app: FastifyInstance;
  let operatorToken: string;
  let applicationId: string;
  let secretKey: string;
  let publishableKey: string;
  let known: string;
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
    redis.client = null;
    vi.restoreAllMocks();
  });

  /** Every request leaves from a different client address, as a distributed caller's would. */
  const fromNewIp = (): { remoteAddress: string; forwarded: Record<string, string> } => {
    ipCounter += 1;
    return {
      remoteAddress: PROXY,
      forwarded: { 'x-forwarded-for': `203.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}` },
    };
  };

  function call(
    method: 'POST' | 'GET',
    url: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    const { remoteAddress, forwarded } = fromNewIp();
    return app.inject({
      method,
      url: `/api/v1${url}`,
      remoteAddress,
      headers: { ...forwarded, ...headers },
      ...(payload !== undefined && { payload: payload as never }),
    });
  }
  const pk = (): Record<string, string> => ({ authorization: `Bearer ${publishableKey}` });
  const sk = (): Record<string, string> => ({ authorization: `Bearer ${secretKey}` });
  const op = (): Record<string, string> => ({ authorization: `Bearer ${operatorToken}` });

  beforeEach(async () => {
    const slug = `cap-${Math.random().toString(36).slice(2, 8)}`;
    operatorToken = await call('POST', '/tenant/auth/sign-up', {
      email: `op-${slug}@example.com`,
      password: PASSWORD,
      workspaceName: `WS ${slug}`,
    }).then((r) => (r.json().data as { accessToken: string }).accessToken);
    applicationId = await call('POST', '/tenant/applications/', { name: slug, slug }, op()).then(
      (r) => (r.json().data as { id: string }).id,
    );
    secretKey = await call('POST', `/tenant/applications/${applicationId}/api-keys`, { name: 'k', mode: 'live' }, op()).then(
      (r) => (r.json().data as { rawKey: string }).rawKey,
    );
    publishableKey = await prisma.application
      .findUniqueOrThrow({ where: { id: applicationId }, select: { publicKey: true } })
      .then((a) => a.publicKey);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: op(),
      payload: {
        methods: ['password', 'magic_link'],
        appUrl: 'https://app.example.com',
        sendVerificationEmailOnSignUp: false,
        welcomeEmail: 'off',
      },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    known = `known-${slug}@example.com`;
    const created = await call('POST', '/auth/sign-up', { email: known, password: PASSWORD }, sk());
    expect(created.statusCode, created.body).toBe(201);
  });

  const mailsTo = (spy: { mock: { calls: unknown[][] } }, to: string, eventKey?: string): number =>
    spy.mock.calls.filter((c) => {
      const sent = c[0] as { to: string; eventKey: string };
      return sent.to === to && (eventKey === undefined || sent.eventKey === eventKey);
    }).length;

  const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** What a caller can see of a response, minus the fields that differ on every request. */
  const visible = (res: LightMyRequestResponse): { status: number; body: string; headers: string[] } => ({
    status: res.statusCode,
    body: res.body,
    headers: Object.keys(res.headers)
      .filter((h) => !['date', 'x-request-id', 'x-ratelimit-reset', 'retry-after'].includes(h))
      .sort(),
  });

  const routes: Array<[string, string, string]> = [
    ['/auth/forgot-password', 'password_reset', 'forgot-password'],
    ['/auth/magic-link/request', 'magic_link_signin', 'magic-link request'],
    ['/auth/resend-verification', 'email_verification', 'resend-verification'],
  ];

  describe.each(routes)('%s from a browser key', (url, eventKey) => {
    it('the sixth request in an hour sends nothing, and known and unknown addresses answer alike throughout', async () => {
      const dispatch = vi.spyOn(emailService, 'dispatch');
      const unknown = `nobody-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const seenKnown: ReturnType<typeof visible>[] = [];
      const seenUnknown: ReturnType<typeof visible>[] = [];
      for (let i = 0; i < HOURLY_CAP + 1; i++) {
        seenKnown.push(visible(await call('POST', url, { email: known }, pk())));
        seenUnknown.push(visible(await call('POST', url, { email: unknown }, pk())));
      }
      await vi.waitFor(() => expect(mailsTo(dispatch, known, eventKey)).toBe(HOURLY_CAP));
      await settle();
      expect(mailsTo(dispatch, known, eventKey), 'the sixth request must send nothing').toBe(HOURLY_CAP);
      expect(seenKnown.every((r) => r.status === 200)).toBe(true);
      expect(seenKnown).toEqual(seenUnknown);
      expect(seenKnown[HOURLY_CAP]).toEqual(seenKnown[0]);
    });

    it('a secret key is told: 429 AUTH_EMAIL_RECIPIENT_CAPPED with Retry-After', async () => {
      for (let i = 0; i < HOURLY_CAP; i++) {
        expect((await call('POST', url, { email: known }, sk())).statusCode).toBe(200);
      }
      const refused = await call('POST', url, { email: known }, sk());
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.code).toBe('AUTH_EMAIL_RECIPIENT_CAPPED');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(3600);
    });

    it('answers a browser key without waiting for the mail', async () => {
      vi.spyOn(emailService, 'dispatch').mockImplementation(() => new Promise(() => undefined));
      const res = await call('POST', url, { email: known }, pk());
      expect(res.statusCode).toBe(200);
    });

    it('with the counter unreachable, known and unknown addresses both get the same 503', async () => {
      redis.client = {
        eval: async () => {
          throw new Error('Connection is closed.');
        },
        decr: async () => 0,
      };
      const dispatch = vi.spyOn(emailService, 'dispatch');
      const forKnown = await call('POST', url, { email: known }, pk());
      const forUnknown = await call('POST', url, { email: 'nobody-at-all@example.com' }, pk());
      redis.client = null;
      expect(forKnown.statusCode).toBe(503);
      expect(forKnown.json().error.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(visible(forUnknown).status).toBe(503);
      expect(forUnknown.json().error.code).toBe(forKnown.json().error.code);
      await settle();
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('requests that send nothing', () => {
    const silent: Array<[string, string, () => string]> = [
      ['/auth/forgot-password', 'an address with no account', () => `nobody-${Math.random().toString(36).slice(2, 8)}@example.com`],
      ['/auth/resend-verification', 'an address with no account', () => `nobody-${Math.random().toString(36).slice(2, 8)}@example.com`],
    ];

    it.each(silent)('%s for %s does not use up the allowance of mail to it', async (url, _what, address) => {
      const email = address();
      const dispatch = vi.spyOn(emailService, 'dispatch');
      for (let i = 0; i < HOURLY_CAP + 3; i++) {
        expect((await call('POST', url, { email }, pk())).statusCode).toBe(200);
      }
      await settle();
      expect(mailsTo(dispatch, email), 'nothing was sent so far').toBe(0);
      // The person signs up, and their own mail still goes out.
      const created = await call('POST', '/auth/sign-up', { email, password: PASSWORD }, sk());
      expect(created.statusCode, created.body).toBe(201);
      const reset = await call('POST', '/auth/forgot-password', { email }, sk());
      expect(reset.statusCode, 'the address must not be capped by requests that mailed it nothing').toBe(200);
      expect(mailsTo(dispatch, email, 'password_reset')).toBe(1);
    });

    it('a verified address asked for a verification mail it will never get keeps its allowance', async () => {
      await prisma.endUser.updateMany({ where: { applicationId, email: known }, data: { emailVerified: true } });
      const dispatch = vi.spyOn(emailService, 'dispatch');
      for (let i = 0; i < HOURLY_CAP + 3; i++) {
        expect((await call('POST', '/auth/resend-verification', { email: known }, pk())).statusCode).toBe(200);
      }
      await settle();
      const link = await call('POST', '/auth/magic-link/request', { email: known }, sk());
      expect(link.statusCode, link.body).toBe(200);
      expect(mailsTo(dispatch, known, 'magic_link_signin')).toBe(1);
    });

    it('a secret key meets the 429 after the same number of requests whether or not the address has an account', async () => {
      const unknown = `nobody-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const statuses = async (email: string): Promise<number[]> => {
        const seen: number[] = [];
        for (let i = 0; i < HOURLY_CAP + 2; i++) {
          seen.push((await call('POST', '/auth/forgot-password', { email }, sk())).statusCode);
        }
        return seen;
      };
      const forKnown = await statuses(known);
      const forUnknown = await statuses(unknown);
      expect(forKnown).toEqual([200, 200, 200, 200, 200, 429, 429]);
      expect(forUnknown).toEqual(forKnown);
      // Following the fix: the refusal is for requests, the mail allowance of
      // the unknown address is untouched, so once it has an account it is mailed.
      const dispatch = vi.spyOn(emailService, 'dispatch');
      expect((await call('POST', '/auth/sign-up', { email: unknown, password: PASSWORD }, sk())).statusCode).toBe(201);
      expect((await call('POST', '/auth/magic-link/request', { email: unknown }, pk())).statusCode).toBe(200);
      await vi.waitFor(() => expect(mailsTo(dispatch, unknown, 'magic_link_signin')).toBe(1));
    });

    it('an operator address with no account is not capped by reset requests that mailed nothing', async () => {
      const email = `later-op-${Math.random().toString(36).slice(2, 8)}@example.com`;
      for (let i = 0; i < HOURLY_CAP + 3; i++) await call('POST', '/tenant/auth/forgot-password', { email });
      await settle();
      await call('POST', '/tenant/auth/sign-up', { email, password: PASSWORD, workspaceName: 'Later' });
      const res = await call('POST', '/tenant/auth/forgot-password', { email });
      expect((res.json().data as { resetToken: string | null }).resetToken, 'the real request still mints a link').toBeTruthy();
    });
  });

  it('ten callers on ten addresses share the one allowance', async () => {
    const dispatch = vi.spyOn(emailService, 'dispatch');
    for (let i = 0; i < 10; i++) {
      expect((await call('POST', '/auth/forgot-password', { email: known }, pk())).statusCode).toBe(200);
    }
    await vi.waitFor(() => expect(mailsTo(dispatch, known)).toBe(HOURLY_CAP));
    await settle();
    expect(mailsTo(dispatch, known)).toBe(HOURLY_CAP);
  });

  it('the three routes draw on one allowance, not five each', async () => {
    const dispatch = vi.spyOn(emailService, 'dispatch');
    for (const [url] of routes) {
      for (let i = 0; i < 2; i++) await call('POST', url, { email: known }, pk());
    }
    await vi.waitFor(() => expect(mailsTo(dispatch, known)).toBe(HOURLY_CAP));
    await settle();
    expect(mailsTo(dispatch, known)).toBe(HOURLY_CAP);
  });

  it('plus-suffixed addresses, and dotted Gmail ones, are the same mailbox', async () => {
    expect(recipientCapKey('V.i.c+1@Gmail.com')).toBe('vic@gmail.com');
    expect(recipientCapKey('vic+2@googlemail.com')).toBe('vic@gmail.com');
    expect(recipientCapKey('v.ic+1@example.com')).toBe('v.ic@example.com');

    for (let i = 1; i <= HOURLY_CAP; i++) {
      expect((await call('POST', '/auth/magic-link/request', { email: `v+${i}@example.com` }, sk())).statusCode).toBe(200);
    }
    const refused = await call('POST', '/auth/magic-link/request', { email: 'v+99@example.com' }, sk());
    expect(refused.statusCode).toBe(429);
    const other = await call('POST', '/auth/magic-link/request', { email: 'w+1@example.com' }, sk());
    expect(other.statusCode).toBe(200);
  });

  it('a sign-up over the cap still creates the account, with no mail', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: op(),
      payload: { sendVerificationEmailOnSignUp: true, welcomeEmail: 'on_signup' },
    });
    const dispatch = vi.spyOn(emailService, 'dispatch');
    const statuses: number[] = [];
    for (let i = 1; i <= 4; i++) {
      const res = await call('POST', '/auth/sign-up', { email: `bombed+${i}@example.com`, password: PASSWORD }, pk());
      statuses.push(res.statusCode);
      await settle(60);
    }
    expect(statuses).toEqual([201, 201, 201, 201]);
    await settle();
    const sent = dispatch.mock.calls.map((c) => c[0] as { to: string; eventKey: string });
    expect(sent).toHaveLength(HOURLY_CAP);
    expect(sent.filter((m) => m.to === 'bombed+4@example.com')).toHaveLength(0);
    expect(sent.filter((m) => m.eventKey === 'email_verification')).toHaveLength(3);
    expect(await prisma.endUser.count({ where: { applicationId, email: { startsWith: 'bombed+' } } })).toBe(4);
  });

  it('records one security event per recipient per hour, naming a hash and never the address', async () => {
    for (let i = 0; i < HOURLY_CAP + 4; i++) await call('POST', '/auth/forgot-password', { email: known }, pk());
    await settle();
    const events = await prisma.securityEvent.findMany({ where: { applicationId, type: 'auth.email_recipient_capped' } });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ window: 'hour', cap: HOURLY_CAP });
    expect(JSON.stringify(events[0]!.metadata)).not.toContain(known);
  });

  it('security notices are not counted: a password change still mails the address over the cap', async () => {
    for (let i = 0; i < HOURLY_CAP + 1; i++) await call('POST', '/auth/forgot-password', { email: known }, pk());
    const session = await call('POST', '/auth/sign-in', { email: known, password: PASSWORD }, sk());
    const accessToken = (session.json().data as { accessToken: string }).accessToken;
    const dispatch = vi.spyOn(emailService, 'dispatch');
    const changed = await call(
      'POST',
      '/auth/change-password',
      { currentPassword: PASSWORD, newPassword: 'another-pw-one-two-three' },
      { ...sk(), 'x-rekey-user-token': accessToken },
    );
    expect(changed.statusCode, changed.body).toBe(200);
    await vi.waitFor(() => expect(mailsTo(dispatch, known, 'password_changed')).toBe(1));
  });

  it('the signed-in resend is capped too, and says so', async () => {
    const session = await call('POST', '/auth/sign-in', { email: known, password: PASSWORD }, sk());
    const user = { ...sk(), 'x-rekey-user-token': (session.json().data as { accessToken: string }).accessToken };
    for (let i = 0; i < HOURLY_CAP; i++) {
      expect((await call('POST', '/auth/send-verification', {}, user)).statusCode).toBe(200);
    }
    const refused = await call('POST', '/auth/send-verification', {}, user);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('AUTH_EMAIL_RECIPIENT_CAPPED');
  });

  describe('operator mail', () => {
    const operatorRoutes: Array<[string, string]> = [
      ['/tenant/auth/forgot-password', 'resetToken'],
      ['/tenant/auth/magic-link/request', 'token'],
    ];

    it.each(operatorRoutes)('%s: the sixth mail to the address mints nothing and answers like an unknown address', async (url, field) => {
      const email = `capped-op-${Math.random().toString(36).slice(2, 8)}@example.com`;
      // Sign-up mails the confirmation link, which is the first of the five.
      const dispatch = vi.spyOn(emailService, 'dispatchSystem');
      await call('POST', '/tenant/auth/sign-up', { email, password: PASSWORD, workspaceName: 'Capped' });
      expect(mailsTo(dispatch, email, 'operator_email_verification')).toBe(1);
      for (let i = 0; i < HOURLY_CAP - 1; i++) {
        const res = await call('POST', url, { email });
        expect((res.json().data as Record<string, unknown>)[field], 'under the cap the link is minted').toBeTruthy();
      }
      const sixth = await call('POST', url, { email });
      const unknown = await call('POST', url, { email: 'no-such-operator@example.com' });
      expect(visible(sixth)).toEqual(visible(unknown));
      expect(mailsTo(dispatch, email)).toBe(HOURLY_CAP);
    });

    it('the confirmation email is counted too: a sixth mail to the address is refused with 429, and nothing is minted', async () => {
      const email = `confirm-op-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const signUp = await call('POST', '/tenant/auth/sign-up', { email, password: PASSWORD, workspaceName: 'Confirm' });
      const session = { authorization: `Bearer ${(signUp.json().data as { accessToken: string }).accessToken}` };
      const userId = (signUp.json().data as { user: { id: string } }).user.id;
      // Operators in this file start out confirmed (see the fixture at the top). This one has not.
      await prisma.tenantUser.update({ where: { id: userId }, data: { emailVerified: false } });
      for (let i = 0; i < HOURLY_CAP - 1; i++) {
        expect((await call('POST', '/tenant/auth/resend-verification', {}, session)).statusCode).toBe(200);
      }
      const newest = await prisma.tenantEmailVerificationToken.findFirstOrThrow({ where: { tenantUserId: userId } });
      const refused = await call('POST', '/tenant/auth/resend-verification', {}, session);
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.code).toBe('AUTH_EMAIL_RECIPIENT_CAPPED');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(
        await prisma.tenantEmailVerificationToken.findMany({ where: { tenantUserId: userId }, select: { id: true } }),
        'the refused request minted nothing and left the newest link in place',
      ).toEqual([{ id: newest.id }]);
    });

    it('an invitation over the cap is still created, without the mail', async () => {
      const invitee = `invitee-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const dispatch = vi.spyOn(emailService, 'dispatchSystem');
      const results: LightMyRequestResponse[] = [];
      for (let i = 0; i < HOURLY_CAP + 1; i++) {
        results.push(await call('POST', '/tenant/workspace/invitations', { email: invitee, role: 'MEMBER' }, op()));
      }
      expect(results.map((r) => r.statusCode)).toEqual(Array(HOURLY_CAP + 1).fill(201));
      expect((results[HOURLY_CAP]!.json().data as { token: string }).token).toBeTruthy();
      expect(mailsTo(dispatch, invitee)).toBe(HOURLY_CAP);
    });
  });
});
