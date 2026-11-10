/**
 * Under `authConfig.mfa: 'required'` a session whose user has no confirmed
 * authenticator answers only the routes needed to enrol, see who is signed
 * in, or sign out. Everything else is refused with MFA_ENROLLMENT_REQUIRED,
 * for a secret key as for a publishable one. Impersonation is never held back.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const PASSWORD = 'pw-one-two-three';
type Method = 'GET' | 'POST';

describe('mfa required is enforced on the session', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let endUserId: string;
  let tenantAccess: string;
  let liveKey: string;
  let publicKey: string;
  let userToken: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const slug = `mfareq-${Math.random().toString(36).slice(2, 8)}`;
    tenantAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const created = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: `App ${slug}`, slug },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    applicationId = created.id;
    publicKey = created.publicKey;
    const billing = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/billing-config`,
      headers: { authorization: `Bearer ${tenantAccess}` },
      payload: { enabled: true },
    });
    expect(billing.statusCode, billing.body).toBe(200);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    const signedUp = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${slug}@example.com`, password: PASSWORD, emailVerified: true },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
    userToken = signedUp.accessToken;
    endUserId = signedUp.endUser.id;
  });

  const setMfaPolicy = async (mfa: 'off' | 'optional' | 'required') => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: { authorization: `Bearer ${tenantAccess}` },
      payload: { mfa },
    });
    expect(res.statusCode).toBe(200);
  };

  const call = (method: Method, url: string, key = publicKey, token = userToken, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key}`, 'x-rekey-user-token': token },
      ...(payload !== undefined && { payload }),
    });

  const refusal = (res: { statusCode: number; json: () => { error?: { code?: string } } }) =>
    res.statusCode === 403 ? res.json().error?.code : undefined;

  const ORDINARY: Array<[Method, string]> = [
    ['GET', '/api/v1/users/me/devices'],
    ['GET', '/api/v1/billing/entitlements'],
    ['GET', '/api/v1/auth/sessions'],
    ['GET', '/api/v1/users/me/?include=subscription'],
  ];

  async function enrol(): Promise<void> {
    const setup = await call('POST', '/api/v1/auth/mfa/setup', publicKey, userToken, {});
    expect(setup.statusCode, setup.body).toBe(201);
    const totp = OTPAuth.URI.parse(setup.json().data.otpauthUrl as string) as OTPAuth.TOTP;
    const confirm = await call('POST', '/api/v1/auth/mfa/setup-confirm', publicKey, userToken, {
      code: totp.generate(),
    });
    expect(confirm.statusCode, confirm.body).toBe(200);
  }

  it('refuses ordinary routes for an unenrolled user', async () => {
    await setMfaPolicy('required');
    for (const [method, url] of ORDINARY) {
      expect(refusal(await call(method, url)), url).toBe('MFA_ENROLLMENT_REQUIRED');
    }
  });

  it('refuses the routes that add or replace a credential for an unenrolled user', async () => {
    await setMfaPolicy('required');
    for (const url of ['/api/v1/auth/email-code', '/api/v1/auth/set-password', '/api/v1/auth/mfa/backup-codes']) {
      expect(refusal(await call('POST', url, publicKey, userToken, {})), url).toBe('MFA_ENROLLMENT_REQUIRED');
    }
  });

  it('refuses a secret-key caller the same way', async () => {
    await setMfaPolicy('required');
    for (const [method, url] of ORDINARY) {
      expect(refusal(await call(method, url, liveKey)), url).toBe('MFA_ENROLLMENT_REQUIRED');
    }
  });

  it('refuses the includes of GET /auth/me but answers the bare record', async () => {
    await setMfaPolicy('required');
    const bare = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { 'x-rekey-user-token': userToken },
    });
    expect(bare.statusCode, bare.body).toBe(200);
    const withInclude = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me?include=device',
      headers: { 'x-rekey-user-token': userToken },
    });
    expect(refusal(withInclude)).toBe('MFA_ENROLLMENT_REQUIRED');
  });

  it('answers each route needed to enrol, see who is signed in, or leave', async () => {
    await setMfaPolicy('required');
    expect((await call('GET', '/api/v1/auth/mfa/status')).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/users/me/')).statusCode).toBe(200);
    // Already verified, so a 400 from the handler: it got past the session guard.
    const send = await call('POST', '/api/v1/auth/send-verification', publicKey, userToken, {});
    expect(refusal(send)).toBeUndefined();
    expect(send.statusCode).toBeLessThan(500);
    // Setup and setup-confirm are exercised by `enrol`.
    await enrol();
  });

  it('answers sign-out-everywhere before enrolment', async () => {
    await setMfaPolicy('required');
    const out = await call('POST', '/api/v1/auth/sign-out-everywhere');
    expect(out.statusCode, out.body).toBe(200);
  });

  it('answers everything once the user has enrolled', async () => {
    await setMfaPolicy('required');
    await enrol();
    for (const [method, url] of ORDINARY) {
      const res = await call(method, url);
      expect(res.statusCode, `${url} ${res.body}`).toBe(200);
    }
  });

  it('leaves optional and off alone', async () => {
    for (const policy of ['optional', 'off'] as const) {
      await setMfaPolicy(policy);
      for (const [method, url] of ORDINARY) {
        const res = await call(method, url);
        expect(res.statusCode, `${policy} ${url} ${res.body}`).toBe(200);
      }
    }
  });

  it('does not hold back an impersonation session', async () => {
    await setMfaPolicy('required');
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/end-users/${endUserId}/impersonate`,
      headers: { authorization: `Bearer ${tenantAccess}` },
      payload: { reason: 'support ticket' },
    });
    expect(minted.statusCode, minted.body).toBe(200);
    const token = minted.json().data.accessToken as string;
    for (const [method, url] of ORDINARY) {
      const res = await call(method, url, liveKey, token);
      expect(res.statusCode, `${url} ${res.body}`).toBe(200);
    }
  });

  it('flags mfaEnrollmentRequired at sign-in exactly when the session would be refused', async () => {
    await setMfaPolicy('required');
    const email = (await prisma.endUser.findUniqueOrThrow({ where: { id: endUserId } })).email;
    const signIn = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${publicKey}` },
        payload: { email, password: PASSWORD },
      });
    const before = (await signIn()).json().data as { mfaEnrollmentRequired?: boolean; accessToken: string };
    expect(before.mfaEnrollmentRequired).toBe(true);
    expect(refusal(await call('GET', '/api/v1/users/me/devices', publicKey, before.accessToken))).toBe(
      'MFA_ENROLLMENT_REQUIRED',
    );
    await enrol();
    expect((await signIn()).json().data.mfaRequired).toBe(true);
  });
});
