/**
 * POST /auth/mfa/backup-codes issues a fresh set of backup codes and kills the
 * old set, but only for the holder of the authenticator: a current TOTP code
 * is required, a backup code is refused, and a session alone gets nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { endUsersConfirmTheirEmail, operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();
endUsersConfirmTheirEmail();

const PASSWORD = 'pw-one-two-three';

interface Fixture {
  liveKey: string;
  publicKey: string;
  endUserId: string;
  token: string;
}

describe('replacing two-factor backup codes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  async function bootstrap(): Promise<Fixture> {
    const tag = `bc-${++n}-${Math.random().toString(36).slice(2, 7)}`;
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
      data: { authConfig: { ...(current.authConfig as object), mfa: 'optional', passwordBreachCheckEnabled: false } as never },
    });
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${tag}@example.com`, password: PASSWORD },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
    return { liveKey, publicKey: application.publicKey, endUserId: eu.endUser.id, token: eu.accessToken };
  }

  const browser = (f: Fixture) => ({ authorization: `Bearer ${f.publicKey}`, 'x-rekey-user-token': f.token });

  /** Enrols TOTP; returns the first backup codes and a generator for the authenticator's next codes. */
  async function enrol(f: Fixture): Promise<{ backupCodes: string[]; nextCode: (stepsAhead?: number) => string }> {
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/setup', headers: browser(f) });
    expect(setup.statusCode).toBe(201);
    const data = setup.json().data as { otpauthUrl: string; backupCodes: string[] };
    const totp = OTPAuth.URI.parse(data.otpauthUrl);
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup-confirm',
      headers: browser(f),
      payload: { code: totp.generate() },
    });
    expect(confirm.statusCode).toBe(200);
    // The confirming code spent this step, so later proofs use a later one.
    return { backupCodes: data.backupCodes, nextCode: (ahead = 1) => totp.generate({ timestamp: Date.now() + ahead * 30_000 }) };
  }

  const replace = (f: Fixture, payload: Record<string, unknown> | undefined, headers = browser(f)) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/mfa/backup-codes', headers, ...(payload && { payload }) });
  const challenge = (f: Fixture, code: string) =>
    app
      .inject({ method: 'POST', url: '/api/v1/auth/mfa/challenge', headers: browser(f), payload: { code } })
      .then((r) => (r.json().data as { ok: boolean }).ok);

  it('issues ten new codes for a current authenticator code, and every old code stops working', async () => {
    const f = await bootstrap();
    const { backupCodes: old, nextCode } = await enrol(f);
    expect(await challenge(f, old[0]!)).toBe(true);

    const res = await replace(f, { code: nextCode() });
    expect(res.statusCode).toBe(201);
    const fresh = (res.json().data as { backupCodes: string[] }).backupCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh.some((c) => old.includes(c))).toBe(false);

    const status = await app.inject({ method: 'GET', url: '/api/v1/auth/mfa/status', headers: browser(f) });
    expect((status.json().data as { remainingBackupCodes: number }).remainingBackupCodes).toBe(10);
    expect(await challenge(f, old[1]!)).toBe(false);
    expect(await challenge(f, fresh[0]!)).toBe(true);

    const events = await prisma.securityEvent.findMany({
      where: { type: 'user.backup_codes_replaced', actorId: f.endUserId },
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(fresh[1]!);
  });

  it('refuses a session with no code, from a browser and from a server alike', async () => {
    const f = await bootstrap();
    const { backupCodes } = await enrol(f);
    expect((await replace(f, undefined)).statusCode).toBe(400);
    expect((await replace(f, {})).statusCode).toBe(400);
    expect((await replace(f, {}, { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': f.token })).statusCode).toBe(400);
    expect(await challenge(f, backupCodes[0]!)).toBe(true);
  });

  it('refuses a backup code as the proof, so one leaked code cannot mint ten', async () => {
    const f = await bootstrap();
    const { backupCodes } = await enrol(f);
    const res = await replace(f, { code: backupCodes[0]! });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MFA_CODE_INVALID');
    // Nothing changed: the code offered is still unspent and the set is intact.
    expect(await challenge(f, backupCodes[0]!)).toBe(true);
    expect(await challenge(f, backupCodes[1]!)).toBe(true);
  });

  it('refuses a code already accepted', async () => {
    const f = await bootstrap();
    const { nextCode } = await enrol(f);
    const code = nextCode();
    expect((await replace(f, { code })).statusCode).toBe(201);
    const again = await replace(f, { code });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('MFA_CODE_REUSED');
  });

  it('locks out after repeated wrong codes, even for the right one', async () => {
    const f = await bootstrap();
    const { nextCode } = await enrol(f);
    for (let i = 0; i < 5; i++) expect((await replace(f, { code: '000000' })).json().error.code).toBe('MFA_CODE_INVALID');
    const locked = await replace(f, { code: nextCode() });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('MFA_TOO_MANY_ATTEMPTS');
  });

  it('answers MFA_NOT_ENROLLED for an account with no authenticator', async () => {
    const f = await bootstrap();
    const res = await replace(f, { code: '123456' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MFA_NOT_ENROLLED');
  });
});
