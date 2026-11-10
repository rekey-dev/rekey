/**
 * POST /auth/set-password gives an account with no password (it joined by
 * emailed link or a social provider) its first one, but only with a code from
 * POST /auth/email-code: a password outlives every session, so the session
 * alone must not be enough to set one.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';
import { issueEmailedCode, spendEmailedCode } from '../src/modules/auth/emailed-code.js';
import { endUsersConfirmTheirEmail, operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();
endUsersConfirmTheirEmail();

const PASSWORD = 'pw-one-two-three';
const NEW_PASSWORD = 'a-brand-new-password-9';

interface Fixture {
  applicationId: string;
  liveKey: string;
  publicKey: string;
  email: string;
  endUserId: string;
  token: string;
}

describe('setting a first password', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => vi.restoreAllMocks());

  let n = 0;
  async function bootstrap(opts: { withPassword?: boolean } = {}): Promise<Fixture> {
    const tag = `fp-${++n}-${Math.random().toString(36).slice(2, 7)}`;
    const op = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${tag}@example.com`, password: PASSWORD, workspaceName: 'WS' },
      })
      .then((r) => r.json().data as { accessToken: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: { name: `App ${tag}`, slug: tag },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    const email = `eu-${tag}@example.com`;
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email, password: PASSWORD },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
    // As if the account had joined by emailed link: verified, no password.
    if (!opts.withPassword) await prisma.endUser.update({ where: { id: eu.endUser.id }, data: { passwordHash: null } });
    return { applicationId: application.id, liveKey, publicKey: application.publicKey, email, endUserId: eu.endUser.id, token: eu.accessToken };
  }

  const browser = (f: Fixture) => ({ authorization: `Bearer ${f.publicKey}`, 'x-rekey-user-token': f.token });

  /** Delivers every auth mail and hands back the codes it carried. */
  function mailbox(): string[] {
    const codes: string[] = [];
    vi.spyOn(emailService, 'dispatch').mockImplementation(async (input) => {
      if (input.eventKey === 'account_code') codes.push(String(input.variables.code));
      return { kind: 'sent', messageId: null, via: 'byo' } as never;
    });
    return codes;
  }

  const askForCode = (f: Fixture, purpose = 'set_password', headers = browser(f)) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/email-code', headers, payload: { purpose } });
  const setPassword = (f: Fixture, payload: Record<string, unknown>, headers = browser(f)) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/set-password', headers, payload });
  const signIn = (f: Fixture, password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${f.liveKey}` },
      payload: { email: f.email, password },
    });

  it('sets the password with the emailed code, ends every session, and the code never reaches the response', async () => {
    const f = await bootstrap();
    const codes = mailbox();
    const asked = await askForCode(f);
    expect(asked.statusCode).toBe(200);
    expect(asked.json().data.sent).toBe(true);
    expect(codes).toHaveLength(1);
    expect(asked.body).not.toContain(codes[0]!);

    const res = await setPassword(f, { newPassword: NEW_PASSWORD, emailCode: codes[0]! });
    expect(res.statusCode).toBe(200);
    expect((await signIn(f, NEW_PASSWORD)).statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: browser(f) });
    expect(me.statusCode).toBe(401);
    expect(await prisma.securityEvent.count({ where: { type: 'user.password_set', actorId: f.endUserId } })).toBe(1);
  });

  it('refuses a session with no code, from a browser and from a server alike', async () => {
    const f = await bootstrap();
    mailbox();
    expect((await setPassword(f, { newPassword: NEW_PASSWORD })).statusCode).toBe(400);
    const server = { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': f.token };
    expect((await setPassword(f, { newPassword: NEW_PASSWORD }, server)).statusCode).toBe(400);
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: f.endUserId } })).passwordHash).toBeNull();
  });

  it('refuses a wrong code, a code for another purpose, and the right code after five wrong tries', async () => {
    const f = await bootstrap();
    const codes = mailbox();
    await askForCode(f, 'delete_account');
    const otherPurpose = await setPassword(f, { newPassword: NEW_PASSWORD, emailCode: codes[0]! });
    expect(otherPurpose.statusCode).toBe(401);
    expect(otherPurpose.json().error.code).toBe('EMAIL_CODE_INVALID');

    await askForCode(f);
    const right = codes[1]!;
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      expect((await setPassword(f, { newPassword: NEW_PASSWORD, emailCode: wrong })).json().error.code).toBe('EMAIL_CODE_INVALID');
    }
    expect((await setPassword(f, { newPassword: NEW_PASSWORD, emailCode: right })).json().error.code).toBe('EMAIL_CODE_INVALID');
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: f.endUserId } })).passwordHash).toBeNull();
  });

  it('takes each code once', async () => {
    const f = await bootstrap();
    const codes = mailbox();
    await askForCode(f);
    expect((await setPassword(f, { newPassword: NEW_PASSWORD, emailCode: codes[0]! })).statusCode).toBe(200);
    expect(await spendEmailedCode(f.endUserId, 'set_password', codes[0]!)).toBe(false);
  });

  it('refuses an account that already has a password, sending no code and spending none', async () => {
    const f = await bootstrap({ withPassword: true });
    const codes = mailbox();
    const asked = await askForCode(f);
    expect(asked.statusCode).toBe(409);
    expect(asked.json().error.code).toBe('PASSWORD_ALREADY_SET');
    expect(codes).toEqual([]);

    const code = await issueEmailedCode(f.endUserId, 'set_password');
    const res = await setPassword(f, { newPassword: NEW_PASSWORD, emailCode: code });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PASSWORD_ALREADY_SET');
    expect(await spendEmailedCode(f.endUserId, 'set_password', code)).toBe(true);
  });

  it('applies the sign-up length rule and the password method switch', async () => {
    const f = await bootstrap();
    const codes = mailbox();
    await askForCode(f);
    const short = await setPassword(f, { newPassword: 'short', emailCode: codes[0]! });
    expect(short.json().error.code).toBe('PASSWORD_TOO_SHORT');

    const current = await prisma.application.findUniqueOrThrow({ where: { id: f.applicationId } });
    await prisma.application.update({
      where: { id: f.applicationId },
      data: { authConfig: { ...(current.authConfig as object), methods: ['magic_link'] } as never },
    });
    const off = await setPassword(f, { newPassword: NEW_PASSWORD, emailCode: codes[0]! });
    expect(off.statusCode).toBe(400);
    expect(off.json().error.code).toBe('AUTH_METHOD_DISABLED');
  });

  it('applies the breach check before the code is spent', async () => {
    const f = await bootstrap();
    const codes = mailbox();
    await askForCode(f);
    const current = await prisma.application.findUniqueOrThrow({ where: { id: f.applicationId } });
    await prisma.application.update({
      where: { id: f.applicationId },
      data: { authConfig: { ...(current.authConfig as object), passwordBreachCheckEnabled: true } as never },
    });
    const realFetch = globalThis.fetch;
    // SHA-1 of NEW_PASSWORD's suffix is unknown to the test, so answer every range with the suffix asked about.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api.pwnedpasswords.com/range/')) return realFetch(input, init);
      const { createHash } = await import('node:crypto');
      const suffix = createHash('sha1').update(NEW_PASSWORD).digest('hex').toUpperCase().slice(5);
      return new Response(`${suffix}:42\r\n`, { status: 200 });
    });
    const res = await setPassword(f, { newPassword: NEW_PASSWORD, emailCode: codes[0]! });
    expect(res.json().error.code).toBe('PASSWORD_BREACHED');
    expect(await spendEmailedCode(f.endUserId, 'set_password', codes[0]!)).toBe(true);
  });

  it('sends no code to an unconfirmed address', async () => {
    const f = await bootstrap();
    await prisma.endUser.update({ where: { id: f.endUserId }, data: { emailVerified: false } });
    const codes = mailbox();
    const res = await askForCode(f);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(codes).toEqual([]);
  });

  it('says so when the code could not be emailed, and leaves no live code behind', async () => {
    const f = await bootstrap();
    let code = '';
    vi.spyOn(emailService, 'dispatch').mockImplementation(async (input) => {
      code = String(input.variables.code);
      return { kind: 'no_transport' };
    });
    const res = await askForCode(f);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('EMAIL_CODE_NOT_SENT');
    expect(res.body).not.toContain(code);
    expect(await spendEmailedCode(f.endUserId, 'set_password', code)).toBe(false);
  });

  it('refuses a purpose it does not know', async () => {
    const f = await bootstrap();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-code',
      headers: browser(f),
      payload: { purpose: 'nonsense' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('emailed codes in Redis', () => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/4', { lazyConnect: true, maxRetriesPerRequest: 1 });
  let reachable = false;
  beforeAll(async () => {
    reachable = await redis.connect().then(() => true, () => false);
  });
  afterAll(async () => {
    redis.disconnect();
  });

  it('spends the live code once, refuses another purpose, and ends it after five wrong tries', async (ctx) => {
    if (!reachable) ctx.skip();
    const user = `redis-${Math.random().toString(36).slice(2)}`;
    const code = await issueEmailedCode(user, 'set_password', redis);
    expect(await spendEmailedCode(user, 'delete_account', code, redis)).toBe(false);
    expect(await spendEmailedCode(user, 'set_password', code, redis)).toBe(true);
    expect(await spendEmailedCode(user, 'set_password', code, redis)).toBe(false);

    const next = await issueEmailedCode(user, 'set_password', redis);
    const wrong = next === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect(await spendEmailedCode(user, 'set_password', wrong, redis)).toBe(false);
    expect(await spendEmailedCode(user, 'set_password', next, redis)).toBe(false);
    expect(await redis.ttl(`eu:emailed-code:set_password:${user}`)).toBe(-2);
  });
});
