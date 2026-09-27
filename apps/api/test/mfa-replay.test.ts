/**
 * MFA replay resistance, end-user and operator.
 *
 * A pentest found that one TOTP code verified three times on step-up, and that
 * one sign-in challenge token plus one code minted two full sessions. RFC 6238
 * section 5.2 says a verifier must not accept the same code twice, and a
 * challenge token is meant to complete one sign-in.
 *
 * The clock is pinned to the middle of a 30-second step so `codeAt(n)` names
 * an exact step and nothing here can flake on a step boundary.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { setDefaultDeviceLimit } from './device-fixtures.js';

const PASSWORD = 'pw-one-two-three';
const STEP_MS = 30_000;
const RACERS = 8;

type Totp = { codeAt: (steps: number) => string };

function totpFrom(otpauthUrl: string): Totp {
  const totp = OTPAuth.URI.parse(otpauthUrl) as OTPAuth.TOTP;
  return { codeAt: (steps) => totp.generate({ timestamp: Date.now() + steps * STEP_MS }) };
}

describe('MFA replay resistance', () => {
  let app: FastifyInstance;
  let ipCounter = 0;
  const freshIp = (): string => `10.77.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    vi.setSystemTime(now - (now % STEP_MS) + STEP_MS / 2);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('end-user', () => {
    interface Ctx {
      liveKey: string;
      operatorToken: string;
      publicKey: string;
      applicationId: string;
      endUserId: string;
      email: string;
      accessToken: string;
      totp: Totp;
      backupCodes: string[];
    }

    async function enrolledEndUser(slug: string, confirmAtStep = -1): Promise<Ctx> {
      const op = await app
        .inject({
          remoteAddress: freshIp(),
          method: 'POST',
          url: '/api/v1/tenant/auth/sign-up',
          payload: { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
        })
        .then((r) => r.json().data as { accessToken: string });
      const application = await app
        .inject({
          remoteAddress: freshIp(),
          method: 'POST',
          url: '/api/v1/tenant/applications/',
          headers: { authorization: `Bearer ${op.accessToken}` },
          payload: { name: `App ${slug}`, slug },
        })
        .then((r) => r.json().data as { id: string; publicKey: string });
      const liveKey = await app
        .inject({
          remoteAddress: freshIp(),
          method: 'POST',
          url: `/api/v1/tenant/applications/${application.id}/api-keys`,
          headers: { authorization: `Bearer ${op.accessToken}` },
          payload: { name: 'k', mode: 'live' },
        })
        .then((r) => (r.json().data as { rawKey: string }).rawKey);
      const email = `eu-${slug}@example.com`;
      const eu = await app
        .inject({
          remoteAddress: freshIp(),
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${liveKey}` },
          payload: { email, password: PASSWORD },
        })
        .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
      const setup = await app
        .inject({
          remoteAddress: freshIp(),
          method: 'POST',
          url: '/api/v1/auth/mfa/setup',
          headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': eu.accessToken },
        })
        .then((r) => r.json().data as { otpauthUrl: string; backupCodes: string[] });
      const totp = totpFrom(setup.otpauthUrl);
      const confirm = await app.inject({
        remoteAddress: freshIp(),
        method: 'POST',
        url: '/api/v1/auth/mfa/setup-confirm',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': eu.accessToken },
        payload: { code: totp.codeAt(confirmAtStep) },
      });
      expect(confirm.statusCode).toBe(200);
      return {
        liveKey,
        operatorToken: op.accessToken,
        publicKey: application.publicKey,
        applicationId: application.id,
        endUserId: eu.endUser.id,
        email,
        accessToken: eu.accessToken,
        totp,
        backupCodes: setup.backupCodes,
      };
    }

    async function challengeFor(ctx: Ctx): Promise<string> {
      const res = await app.inject({
        remoteAddress: freshIp(),
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${ctx.liveKey}` },
        payload: { email: ctx.email, password: PASSWORD },
      });
      const data = res.json().data as { mfaRequired: boolean; mfaChallengeToken: string };
      expect(data.mfaRequired).toBe(true);
      return data.mfaChallengeToken;
    }

    const mfaVerify = (ctx: Ctx, mfaChallengeToken: string, code: string, fingerprint?: string) =>
      app.inject({
        remoteAddress: freshIp(),
        method: 'POST',
        url: '/api/v1/auth/mfa-verify',
        headers: { authorization: `Bearer ${ctx.liveKey}` },
        payload: { mfaChallengeToken, code, ...(fingerprint && { device: { fingerprint } }) },
      });

    const stepUp = (ctx: Ctx, code: string) =>
      app
        .inject({
          remoteAddress: freshIp(),
          method: 'POST',
          url: '/api/v1/auth/mfa/challenge',
          headers: { authorization: `Bearer ${ctx.liveKey}`, 'x-rekey-user-token': ctx.accessToken },
          payload: { code },
        })
        .then((r) => (r.json().data as { ok: boolean }).ok);

    async function remainingBackupCodes(ctx: Ctx): Promise<number> {
      const res = await app.inject({
        remoteAddress: freshIp(),
        method: 'GET',
        url: '/api/v1/auth/mfa/status',
        headers: { authorization: `Bearer ${ctx.liveKey}`, 'x-rekey-user-token': ctx.accessToken },
      });
      return (res.json().data as { remainingBackupCodes: number }).remainingBackupCodes;
    }

    it('step-up refuses a TOTP code it has already accepted, and any older one', async () => {
      const ctx = await enrolledEndUser('eu-stepup');
      const code = ctx.totp.codeAt(0);
      expect(await stepUp(ctx, code)).toBe(true);
      expect(await stepUp(ctx, code)).toBe(false);
      expect(await stepUp(ctx, code)).toBe(false);
      expect(await stepUp(ctx, ctx.totp.codeAt(1))).toBe(true);
      expect(await stepUp(ctx, ctx.totp.codeAt(0))).toBe(false);
    });

    it('the code that confirmed enrolment cannot also complete a sign-in', async () => {
      const ctx = await enrolledEndUser('eu-confirm', 0);
      const res = await mfaVerify(ctx, await challengeFor(ctx), ctx.totp.codeAt(0));
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('MFA_CODE_REUSED');
    });

    it('browser step-up (re-enrol, disable) names a replayed code as reused', async () => {
      const ctx = await enrolledEndUser('eu-browser-stepup', 0);
      const asBrowser = (url: string, code: string) =>
        app.inject({
          remoteAddress: freshIp(),
          method: 'POST',
          url,
          headers: { authorization: `Bearer ${ctx.publicKey}`, 'x-rekey-user-token': ctx.accessToken },
          payload: { code },
        });
      for (const url of ['/api/v1/auth/mfa/setup', '/api/v1/auth/mfa/disable']) {
        const replayed = await asBrowser(url, ctx.totp.codeAt(0));
        expect(replayed.statusCode).toBe(401);
        expect(replayed.json().error.code).toBe('MFA_CODE_REUSED');
      }
      expect((await asBrowser('/api/v1/auth/mfa/disable', ctx.totp.codeAt(1))).statusCode).toBe(200);
    });

    it('a double-submitted enrolment confirmation is refused as reused', async () => {
      const ctx = await enrolledEndUser('eu-confirm-twice', 0);
      const again = await app.inject({
        remoteAddress: freshIp(),
        method: 'POST',
        url: '/api/v1/auth/mfa/setup-confirm',
        headers: { authorization: `Bearer ${ctx.liveKey}`, 'x-rekey-user-token': ctx.accessToken },
        payload: { code: ctx.totp.codeAt(0) },
      });
      expect(again.statusCode).toBe(422);
      expect(again.json().error.code).toBe('MFA_CODE_REUSED');
    });

    it('a sign-in challenge token completes one sign-in only', async () => {
      const ctx = await enrolledEndUser('eu-challenge');
      const token = await challengeFor(ctx);
      const first = await mfaVerify(ctx, token, ctx.totp.codeAt(0));
      expect(first.statusCode).toBe(200);

      const replay = await mfaVerify(ctx, token, ctx.backupCodes[0]!);
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe('MFA_CHALLENGE_USED');
      expect(await remainingBackupCodes(ctx)).toBe(10);
    });

    it('spending one challenge does not spend another minted in the same second', async () => {
      const ctx = await enrolledEndUser('eu-same-second');
      const first = await challengeFor(ctx);
      const second = await challengeFor(ctx);
      expect((await mfaVerify(ctx, first, ctx.totp.codeAt(0))).statusCode).toBe(200);
      expect((await mfaVerify(ctx, second, ctx.totp.codeAt(1))).statusCode).toBe(200);
    });

    it(`${RACERS} sign-ins racing one TOTP code mint exactly one session`, async () => {
      const ctx = await enrolledEndUser('eu-race-totp');
      const tokens: string[] = [];
      for (let i = 0; i < RACERS; i++) tokens.push(await challengeFor(ctx));
      const code = ctx.totp.codeAt(0);
      const results = await Promise.all(tokens.map((t) => mfaVerify(ctx, t, code)));
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      for (const r of results.filter((x) => x.statusCode !== 200)) {
        expect(r.json().error.code).toBe('MFA_CODE_REUSED');
      }
    });

    it(`${RACERS} racers on one challenge token mint exactly one session`, async () => {
      const ctx = await enrolledEndUser('eu-race-challenge');
      const token = await challengeFor(ctx);
      const results = await Promise.all(
        ctx.backupCodes.slice(0, RACERS).map((code) => mfaVerify(ctx, token, code)),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      for (const r of results.filter((x) => x.statusCode !== 200)) {
        expect(r.json().error.code).toBe('MFA_CHALLENGE_USED');
      }
    });

    it('a device refusal spends neither the challenge nor the code, so the user can resubmit', async () => {
      const ctx = await enrolledEndUser('eu-device-limit');
      await setDefaultDeviceLimit(app, ctx.operatorToken, ctx.applicationId, 1);
      const release = (deviceId: string) =>
        app.inject({
          remoteAddress: freshIp(),
          method: 'POST',
          url: `/api/v1/tenant/applications/${ctx.applicationId}/end-users/${ctx.endUserId}/devices/${deviceId}/release`,
          headers: { authorization: `Bearer ${ctx.operatorToken}` },
        });
      const deviceIdOf = (res: { json: () => { data: { deviceId: string } } }) => res.json().data.deviceId;

      const laptop = await mfaVerify(ctx, await challengeFor(ctx), ctx.totp.codeAt(0), 'fp-laptop-000001');
      expect(laptop.statusCode).toBe(200);

      // TOTP: refused at the limit, then the same challenge and code succeed.
      const phoneChallenge = await challengeFor(ctx);
      const phoneCode = ctx.totp.codeAt(1);
      const refused = await mfaVerify(ctx, phoneChallenge, phoneCode, 'fp-phone-0000001');
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('DEVICE_LIMIT_REACHED');
      expect((await release(deviceIdOf(laptop))).statusCode).toBe(200);
      const phone = await mfaVerify(ctx, phoneChallenge, phoneCode, 'fp-phone-0000001');
      expect(phone.statusCode).toBe(200);

      // Backup code: refused at the limit without being consumed.
      const tabletChallenge = await challengeFor(ctx);
      const backup = ctx.backupCodes[0]!;
      const refusedBackup = await mfaVerify(ctx, tabletChallenge, backup, 'fp-tablet-000001');
      expect(refusedBackup.json().error.code).toBe('DEVICE_LIMIT_REACHED');
      expect(await remainingBackupCodes(ctx)).toBe(10);
      expect((await release(deviceIdOf(phone))).statusCode).toBe(200);
      expect((await mfaVerify(ctx, tabletChallenge, backup, 'fp-tablet-000001')).statusCode).toBe(200);
      expect(await remainingBackupCodes(ctx)).toBe(9);
    });

    it('a wrong code at the device limit is a wrong code: counted, and nothing about devices leaks', async () => {
      const ctx = await enrolledEndUser('eu-limit-junk');
      await setDefaultDeviceLimit(app, ctx.operatorToken, ctx.applicationId, 1);
      const hook = await app.inject({
        remoteAddress: freshIp(),
        method: 'POST',
        url: `/api/v1/tenant/applications/${ctx.applicationId}/webhooks`,
        headers: { authorization: `Bearer ${ctx.operatorToken}` },
        payload: { url: 'http://127.0.0.1:9/never', events: ['*'] },
      });
      expect(hook.statusCode).toBe(201);
      expect((await mfaVerify(ctx, await challengeFor(ctx), ctx.totp.codeAt(0), 'fp-laptop-000001')).statusCode).toBe(200);

      const challenge = await challengeFor(ctx);
      for (let i = 0; i < 4; i++) {
        const junk = await mfaVerify(ctx, challenge, '000000', 'fp-phone-0000001');
        expect(junk.statusCode).toBe(401);
        expect(junk.json().error.code).toBe('MFA_CODE_INVALID');
        expect(junk.json().error.details).toBeUndefined();
      }
      // A spent code proves nothing either, so it is not let past to the device answer.
      const replayed = await mfaVerify(ctx, challenge, ctx.totp.codeAt(0), 'fp-phone-0000001');
      expect(replayed.json().error.code).toBe('MFA_CODE_REUSED');

      // Control: the right code at the limit does announce, exactly once.
      const refused = await mfaVerify(ctx, challenge, ctx.totp.codeAt(1), 'fp-phone-0000001');
      expect(refused.json().error.code).toBe('DEVICE_LIMIT_REACHED');
      const limitEvents = () =>
        Promise.all([
          prisma.webhookDelivery.count({
            where: { applicationId: ctx.applicationId, eventType: 'device.limit_reached' },
          }),
          prisma.securityEvent.count({
            where: { applicationId: ctx.applicationId, type: 'user.device_limit_reached' },
          }),
        ]);
      for (let i = 0; i < 100; i++) {
        const [hooks, events] = await limitEvents();
        if (hooks >= 1 && events >= 1) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(await limitEvents()).toEqual([1, 1]);

      // The four wrong codes counted: one more trips the lockout.
      expect((await mfaVerify(ctx, challenge, '000000', 'fp-phone-0000001')).statusCode).toBe(401);
      const locked = await mfaVerify(ctx, challenge, ctx.totp.codeAt(1), 'fp-phone-0000001');
      expect(locked.statusCode).toBe(429);
      expect(locked.json().error.code).toBe('MFA_TOO_MANY_ATTEMPTS');
    });

    it(`${RACERS} racers on one backup code get exactly one success`, async () => {
      const ctx = await enrolledEndUser('eu-race-backup');
      const code = ctx.backupCodes[0]!;
      const responses = await Promise.all(
        Array.from({ length: RACERS }, () =>
          app.inject({
            remoteAddress: freshIp(),
            method: 'POST',
            url: '/api/v1/auth/mfa/challenge',
            headers: { authorization: `Bearer ${ctx.liveKey}`, 'x-rekey-user-token': ctx.accessToken },
            payload: { code },
          }),
        ),
      );
      const outcomes = responses.map((r) =>
        r.statusCode === 200 ? `ok:${String(r.json().data.ok)}` : `${r.statusCode}:${r.json().error.code}`,
      );
      expect(outcomes.filter((o) => o === 'ok:true')).toHaveLength(1);
      // Every loser presented a spent backup code, which counts as a failed
      // attempt, so on a slow runner the late racers meet the lockout the
      // early ones tripped. Either answer is a refusal; nothing else is.
      for (const o of outcomes.filter((x) => x !== 'ok:true')) {
        expect(['ok:false', '429:MFA_TOO_MANY_ATTEMPTS']).toContain(o);
      }
      expect(await remainingBackupCodes(ctx)).toBe(9);
    });
  });

  describe('operator', () => {
    interface OpCtx {
      email: string;
      accessToken: string;
      totp: Totp;
      backupCodes: string[];
    }

    async function enrolledOperator(slug: string, confirmAtStep = -1): Promise<OpCtx> {
      const email = `op-${slug}@example.com`;
      const signUp = await app.inject({
        remoteAddress: freshIp(),
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email, password: PASSWORD, workspaceName: `WS ${slug}` },
      });
      expect(signUp.statusCode).toBe(201);
      const { accessToken } = signUp.json().data as { accessToken: string };
      const setup = await app
        .inject({
          remoteAddress: freshIp(),
          method: 'POST',
          url: '/api/v1/tenant/auth/mfa/setup',
          headers: { authorization: `Bearer ${accessToken}` },
        })
        .then((r) => r.json().data as { otpauthUrl: string; backupCodes: string[] });
      const totp = totpFrom(setup.otpauthUrl);
      const confirm = await app.inject({
        remoteAddress: freshIp(),
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/setup-confirm',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { code: totp.codeAt(confirmAtStep) },
      });
      expect(confirm.statusCode).toBe(200);
      return { email, accessToken, totp, backupCodes: setup.backupCodes };
    }

    async function challengeFor(ctx: OpCtx): Promise<string> {
      const res = await app.inject({
        remoteAddress: freshIp(),
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-in',
        payload: { email: ctx.email, password: PASSWORD },
      });
      const data = res.json().data as { mfaRequired: boolean; mfaChallengeToken: string };
      expect(data.mfaRequired).toBe(true);
      return data.mfaChallengeToken;
    }

    const mfaVerify = (mfaChallengeToken: string, code: string) =>
      app.inject({
        remoteAddress: freshIp(),
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa-verify',
        payload: { mfaChallengeToken, code },
      });

    async function remainingBackupCodes(ctx: OpCtx): Promise<number> {
      const res = await app.inject({
        remoteAddress: freshIp(),
        method: 'GET',
        url: '/api/v1/tenant/auth/mfa/status',
        headers: { authorization: `Bearer ${ctx.accessToken}` },
      });
      return (res.json().data as { remainingBackupCodes: number }).remainingBackupCodes;
    }

    it('the code that confirmed enrolment cannot also complete a sign-in', async () => {
      const ctx = await enrolledOperator('op-confirm', 0);
      const token = await challengeFor(ctx);
      const res = await mfaVerify(token, ctx.totp.codeAt(0));
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('MFA_CODE_REUSED');
      expect((await mfaVerify(token, ctx.totp.codeAt(1))).statusCode).toBe(200);
    });

    it('a sign-in challenge token completes one sign-in only', async () => {
      const ctx = await enrolledOperator('op-challenge');
      const token = await challengeFor(ctx);
      expect((await mfaVerify(token, ctx.totp.codeAt(0))).statusCode).toBe(200);
      const replay = await mfaVerify(token, ctx.backupCodes[0]!);
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe('MFA_CHALLENGE_USED');
      expect(await remainingBackupCodes(ctx)).toBe(10);
    });

    it('a membership refusal spends neither the challenge nor the code', async () => {
      const ctx = await enrolledOperator('op-no-membership');
      const token = await challengeFor(ctx);
      const code = ctx.totp.codeAt(0);
      const user = await prisma.tenantUser.findFirstOrThrow({ where: { email: ctx.email } });
      const memberships = await prisma.tenantMembership.findMany({ where: { tenantUserId: user.id } });
      await prisma.tenantMembership.deleteMany({ where: { tenantUserId: user.id } });

      // Without the second factor, the membership answer is not given.
      const junk = await mfaVerify(token, '000000');
      expect(junk.json().error.code).toBe('MFA_CODE_INVALID');

      const refused = await mfaVerify(token, code);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('NO_TENANT_MEMBERSHIPS');

      await prisma.tenantMembership.createMany({ data: memberships });
      expect((await mfaVerify(token, code)).statusCode).toBe(200);
    });

    it('spending one challenge does not spend another minted in the same second', async () => {
      const ctx = await enrolledOperator('op-same-second');
      const first = await challengeFor(ctx);
      const second = await challengeFor(ctx);
      expect((await mfaVerify(first, ctx.totp.codeAt(0))).statusCode).toBe(200);
      expect((await mfaVerify(second, ctx.totp.codeAt(1))).statusCode).toBe(200);
    });

    it(`${RACERS} sign-ins racing one TOTP code mint exactly one session`, async () => {
      const ctx = await enrolledOperator('op-race-totp');
      const tokens: string[] = [];
      for (let i = 0; i < RACERS; i++) tokens.push(await challengeFor(ctx));
      const code = ctx.totp.codeAt(0);
      const results = await Promise.all(tokens.map((t) => mfaVerify(t, code)));
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      for (const r of results.filter((x) => x.statusCode !== 200)) {
        expect(r.json().error.code).toBe('MFA_CODE_REUSED');
      }
    });

    it(`${RACERS} racers on one challenge token mint exactly one session`, async () => {
      const ctx = await enrolledOperator('op-race-challenge');
      const token = await challengeFor(ctx);
      const results = await Promise.all(
        ctx.backupCodes.slice(0, RACERS).map((code) => mfaVerify(token, code)),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    });

    it(`${RACERS} sign-ins racing one backup code mint exactly one session`, async () => {
      const ctx = await enrolledOperator('op-race-backup');
      const tokens: string[] = [];
      for (let i = 0; i < RACERS; i++) tokens.push(await challengeFor(ctx));
      const code = ctx.backupCodes[0]!;
      const results = await Promise.all(tokens.map((t) => mfaVerify(t, code)));
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(await remainingBackupCodes(ctx)).toBe(9);
    });

    it('a double-submitted enrolment confirmation is refused as reused', async () => {
      const ctx = await enrolledOperator('op-confirm-twice', 0);
      const again = await app.inject({
        remoteAddress: freshIp(),
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/setup-confirm',
        headers: { authorization: `Bearer ${ctx.accessToken}` },
        payload: { code: ctx.totp.codeAt(0) },
      });
      expect(again.statusCode).toBe(422);
      expect(again.json().error.code).toBe('MFA_CODE_REUSED');
    });

    it('the disable step-up refuses a replayed code', async () => {
      const ctx = await enrolledOperator('op-disable', 0);
      const disable = (code: string) =>
        app.inject({
          remoteAddress: freshIp(),
          method: 'POST',
          url: '/api/v1/tenant/auth/mfa/disable',
          headers: { authorization: `Bearer ${ctx.accessToken}` },
          payload: { code },
        });
      const replayed = await disable(ctx.totp.codeAt(0));
      expect(replayed.statusCode).toBe(401);
      expect(replayed.json().error.code).toBe('MFA_CODE_REUSED');
      expect((await disable(ctx.totp.codeAt(1))).statusCode).toBe(200);
    });
  });
});
