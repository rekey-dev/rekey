/**
 * Changing an end-user's email address: POST /users/me/email mails a link to
 * the new address and a notice to the old one, and the address changes only
 * when POST /auth/email-change/confirm spends that link with a session of the
 * same account or its current password. The requester learns nothing about
 * whether the new address already has an account, and the change can never
 * land on one that does.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';
import { endUsersConfirmTheirEmail, operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();
endUsersConfirmTheirEmail();

const PASSWORD = 'pw-one-two-three';
const APP_URL = 'https://app.example.com';

interface Account {
  id: string;
  email: string;
  token: string;
}
interface Fixture {
  applicationId: string;
  liveKey: string;
  publicKey: string;
  user: Account;
}
type Sent = { eventKey: string; to: string; variables: Record<string, unknown> };

describe('changing an email address', () => {
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
  async function bootstrap(): Promise<Fixture> {
    const tag = `ec-${++n}-${Math.random().toString(36).slice(2, 7)}`;
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
    const current = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    await prisma.application.update({
      where: { id: application.id },
      data: { authConfig: { ...(current.authConfig as object), appUrl: APP_URL } as never },
    });
    const f = { applicationId: application.id, liveKey, publicKey: application.publicKey } as Fixture;
    f.user = await signUp(f, `owner-${tag}@example.com`);
    return f;
  }

  async function signUp(f: Pick<Fixture, 'liveKey'>, email: string): Promise<Account> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${f.liveKey}` },
      payload: { email, password: PASSWORD },
    });
    const data = res.json().data as { accessToken: string; endUser: { id: string } };
    return { id: data.endUser.id, email, token: data.accessToken };
  }

  const browser = (f: Fixture, token = f.user.token) => ({ authorization: `Bearer ${f.publicKey}`, 'x-rekey-user-token': token });

  /** Delivers every mail and records it. */
  function outbox(): Sent[] {
    const sent: Sent[] = [];
    vi.spyOn(emailService, 'dispatch').mockImplementation(async (input) => {
      sent.push({ eventKey: input.eventKey, to: input.to, variables: input.variables });
      return { kind: 'sent', messageId: null, via: 'byo' } as never;
    });
    return sent;
  }
  const linkToken = (sent: Sent[]): string => {
    const mail = sent.filter((m) => m.eventKey === 'email_change_confirm').at(-1)!;
    return new URL(String(mail.variables.confirmUrl)).searchParams.get('token')!;
  };

  const request = (f: Fixture, newEmail: string, token = f.user.token) =>
    app.inject({ method: 'POST', url: '/api/v1/users/me/email', headers: browser(f, token), payload: { newEmail } });
  const confirm = (f: Fixture, payload: Record<string, unknown>, session?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-change/confirm',
      headers: session ? browser(f, session) : { authorization: `Bearer ${f.publicKey}` },
      payload,
    });
  const signIn = (f: Fixture, email: string, password = PASSWORD) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${f.liveKey}` },
      payload: { email, password },
    });

  it('mails a link to the new address and a notice to the old one, then changes the address when confirmed in the session', async () => {
    const f = await bootstrap();
    const sent = outbox();
    const res = await request(f, 'Moved@Example.com');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ success: true, data: { sent: true } });
    expect(sent.map((m) => [m.eventKey, m.to])).toEqual([
      ['email_change_confirm', 'moved@example.com'],
      ['email_change_requested', f.user.email],
    ]);
    const token = linkToken(sent);
    expect(String(sent[0]!.variables.confirmUrl).startsWith(`${APP_URL}/email-change?token=`)).toBe(true);
    expect(res.body).not.toContain(token);

    const done = await confirm(f, { token }, f.user.token);
    expect(done.statusCode).toBe(200);
    expect(done.json().data).toEqual({ ok: true, email: 'moved@example.com' });

    expect((await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: browser(f) })).statusCode).toBe(401);
    expect((await signIn(f, f.user.email)).statusCode).toBe(401);
    const back = await signIn(f, 'moved@example.com');
    expect(back.statusCode).toBe(200);
    expect(back.json().data.endUser).toMatchObject({ email: 'moved@example.com', emailVerified: true });
    const events = await prisma.securityEvent.findMany({ where: { actorId: f.user.id, type: { startsWith: 'user.email_change' } } });
    expect(events.map((e) => e.type).sort()).toEqual(['user.email_change_requested', 'user.email_changed']);
  });

  it('confirms with the current password where no session comes with the link, verifying the new address', async () => {
    const f = await bootstrap();
    await prisma.endUser.update({ where: { id: f.user.id }, data: { emailVerified: false } });
    const sent = outbox();
    await request(f, 'elsewhere@example.com');
    const token = linkToken(sent);

    const bare = await confirm(f, { token });
    expect(bare.statusCode).toBe(401);
    expect(bare.json().error.code).toBe('EMAIL_CHANGE_PROOF_REQUIRED');
    const wrong = await confirm(f, { token, password: 'not-the-password' });
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
    const right = await confirm(f, { token, password: PASSWORD });
    expect(right.statusCode).toBe(200);
    const back = await signIn(f, 'elsewhere@example.com');
    expect(back.json().data.endUser).toMatchObject({ email: 'elsewhere@example.com', emailVerified: true });
  });

  it('lets exactly one of many racing confirmations spend a link', async () => {
    const f = await bootstrap();
    const sent = outbox();
    await request(f, 'racer@example.com');
    const token = linkToken(sent);
    const results = await Promise.all(Array.from({ length: 8 }, () => confirm(f, { token, password: PASSWORD })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode !== 200).map((r) => r.json().error.code)).toEqual(
      Array(7).fill('EMAIL_CHANGE_TOKEN_INVALID'),
    );
  });

  it("refuses another account's session as the proof", async () => {
    const f = await bootstrap();
    const other = await signUp(f, `other-${n}@example.com`);
    const sent = outbox();
    await request(f, 'target@example.com');
    const res = await confirm(f, { token: linkToken(sent) }, other.token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('EMAIL_CHANGE_PROOF_REQUIRED');
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: f.user.id } })).email).toBe(f.user.email);
  });

  it("answers the same for an address that already has an account, and never moves onto it", async () => {
    const f = await bootstrap();
    const taken = await signUp(f, `taken-${n}@example.com`);
    const sent = outbox();
    const res = await request(f, taken.email);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ success: true, data: { sent: true } });
    expect(sent.map((m) => [m.eventKey, m.to])).toEqual([
      ['email_change_address_taken', taken.email],
      ['email_change_requested', f.user.email],
    ]);
    expect(JSON.stringify(sent[0]!.variables)).not.toMatch(/token|http/);
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: f.user.id } })).email).toBe(f.user.email);
  });

  it('refuses the confirmation when the address was taken after the request', async () => {
    const f = await bootstrap();
    const sent = outbox();
    await request(f, 'race@example.com');
    await signUp(f, 'race@example.com');
    const res = await confirm(f, { token: linkToken(sent) }, f.user.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_ALREADY_EXISTS');
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: f.user.id } })).email).toBe(f.user.email);
  });

  it('takes each link once, and a newer request cancels the older link', async () => {
    const f = await bootstrap();
    const sent = outbox();
    await request(f, 'first@example.com');
    const first = linkToken(sent);
    await request(f, 'second@example.com');
    const second = linkToken(sent);
    expect((await confirm(f, { token: first, password: PASSWORD })).json().error.code).toBe('EMAIL_CHANGE_TOKEN_INVALID');
    expect((await confirm(f, { token: second, password: PASSWORD })).statusCode).toBe(200);
    expect((await confirm(f, { token: second, password: PASSWORD })).json().error.code).toBe('EMAIL_CHANGE_TOKEN_INVALID');
  });

  it('is cancelled by a password change', async () => {
    const f = await bootstrap();
    const sent = outbox();
    await request(f, 'cancelled@example.com');
    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: browser(f),
      payload: { currentPassword: PASSWORD, newPassword: 'another-password-77' },
    });
    expect(changed.statusCode).toBe(200);
    const res = await confirm(f, { token: linkToken(sent), password: 'another-password-77' });
    expect(res.json().error.code).toBe('EMAIL_CHANGE_TOKEN_INVALID');
  });

  it('keeps change links and verification links apart', async () => {
    const f = await bootstrap();
    const sent = outbox();
    await request(f, 'apart@example.com');
    const change = linkToken(sent);
    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: { authorization: `Bearer ${f.publicKey}` },
      payload: { token: change },
    });
    expect(verify.json().error.code).toBe('EMAIL_VERIFICATION_STALE');

    await prisma.endUser.update({ where: { id: f.user.id }, data: { emailVerified: false } });
    await app.inject({ method: 'POST', url: '/api/v1/auth/send-verification', headers: browser(f), payload: {} });
    const verification = sent.filter((m) => m.eventKey === 'email_verification').at(-1)!;
    const verifyToken = new URL(String(verification.variables.verifyUrl)).searchParams.get('token')!;
    expect((await confirm(f, { token: verifyToken }, f.user.token)).json().error.code).toBe('EMAIL_CHANGE_TOKEN_INVALID');
  });

  it('ends links already mailed to the old address', async () => {
    const f = await bootstrap();
    const sent = outbox();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: { authorization: `Bearer ${f.liveKey}` },
      payload: { email: f.user.email },
    });
    expect(await prisma.passwordResetToken.count({ where: { endUserId: f.user.id, consumedAt: null } })).toBe(1);
    await request(f, 'fresh@example.com');
    expect((await confirm(f, { token: linkToken(sent) }, f.user.token)).statusCode).toBe(200);
    expect(await prisma.passwordResetToken.count({ where: { endUserId: f.user.id, consumedAt: null } })).toBe(0);
  });

  it('refuses the same address, a blocked domain, and an Application that cannot send', async () => {
    const f = await bootstrap();
    outbox();
    const same = await request(f, f.user.email.toUpperCase());
    expect(same.json().error.code).toBe('EMAIL_CHANGE_SAME_ADDRESS');

    const current = await prisma.application.findUniqueOrThrow({ where: { id: f.applicationId } });
    await prisma.application.update({
      where: { id: f.applicationId },
      data: {
        authConfig: { ...(current.authConfig as object), signupRestrictions: { blockedDomains: ['blocked.example'] } } as never,
      },
    });
    const blocked = await request(f, 'someone@blocked.example');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('EMAIL_CHANGE_DOMAIN_NOT_ALLOWED');

    vi.restoreAllMocks();
    vi.spyOn(emailService, 'dispatch').mockResolvedValue({ kind: 'no_transport' });
    const unsent = await request(f, 'nowhere@example.com');
    expect(unsent.statusCode).toBe(503);
    expect(unsent.json().error.code).toBe('EMAIL_CHANGE_NOT_SENT');
    expect(await prisma.emailVerificationToken.count({ where: { endUserId: f.user.id, email: 'nowhere@example.com' } })).toBe(0);
  });
});
