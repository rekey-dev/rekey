/**
 * Per-Application end-user 2FA policy (authConfig.mfa: off | optional | required).
 *   - off      → MFA setup refused (MFA_NOT_ENABLED)
 *   - optional → setup allowed; sign-in carries no enrollment flag
 *   - required → sign-in flags mfaEnrollmentRequired for unenrolled users
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const PASSWORD = 'pw-one-two-three';

describe('end-user MFA policy', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;
  let tenantAccess: string;
  let euEmail: string;
  let euAccess: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const slug = `mfapol-${Math.random().toString(36).slice(2, 8)}`;
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
    euAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: euEmail, password: PASSWORD },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
  });

  const setMfaPolicy = (mfa: 'off' | 'optional' | 'required') =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: { authorization: `Bearer ${tenantAccess}` },
      payload: { mfa },
    });

  const setup = () =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': euAccess },
    });

  const signIn = () =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: euEmail, password: PASSWORD },
    });

  it('off: MFA setup is refused', async () => {
    expect((await setMfaPolicy('off')).statusCode).toBe(200);
    const res = await setup();
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MFA_NOT_ENABLED');
  });

  it('optional: setup allowed; sign-in has no enrollment flag', async () => {
    await setMfaPolicy('optional');
    expect((await setup()).statusCode).toBe(201);
    const signedIn = await signIn();
    const data = signedIn.json().data as { mfaRequired: boolean; mfaEnrollmentRequired?: boolean };
    expect(data.mfaRequired).toBe(false);
    expect(data.mfaEnrollmentRequired).toBeUndefined();
  });

  it('required: sign-in flags mfaEnrollmentRequired for an unenrolled user', async () => {
    await setMfaPolicy('required');
    const signedIn = await signIn();
    const data = signedIn.json().data as { mfaRequired: boolean; mfaEnrollmentRequired?: boolean };
    expect(data.mfaRequired).toBe(false);
    expect(data.mfaEnrollmentRequired).toBe(true);
  });

  it('status reports the policy', async () => {
    await setMfaPolicy('required');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/mfa/status',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': euAccess },
    });
    expect((res.json().data as { policy: string }).policy).toBe('required');
  });
});
