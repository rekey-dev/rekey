/**
 * Operator TOTP enrollment.
 *
 * Regression focus: a wrong code at /setup-confirm must return 422 (not 401).
 * A 401 makes the panel's api() client treat the operator's session as expired
 * and log them out mid-enrollment — the bug this guards against. The session
 * must stay usable, and a correct code must complete enrollment.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { buildApp } from '../src/app.js';

describe('Operator TOTP enrollment', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signUp(email: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName: 'WS' },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { accessToken: string }).accessToken;
  }

  it('returns 422 (not 401) for a wrong setup code and keeps the session alive', async () => {
    const token = await signUp('mfa-422@example.com');

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/mfa/setup',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(setup.statusCode).toBe(201);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/mfa/setup-confirm',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '000000' },
    });
    // The key assertion: NOT 401 — a 401 trips the panel's "session expired →
    // log out" path. 422 = authenticated, but the submitted code is wrong.
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('MFA_CODE_INVALID');

    // Same token still works — the operator was not logged out.
    const status = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/mfa/status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.statusCode).toBe(200);
    expect((status.json().data as { enabled: boolean }).enabled).toBe(false);
  });

  it('enrolls with the correct TOTP code', async () => {
    const token = await signUp('mfa-ok@example.com');

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/mfa/setup',
      headers: { authorization: `Bearer ${token}` },
    });
    const { otpauthUrl } = setup.json().data as { otpauthUrl: string };
    const code = OTPAuth.URI.parse(otpauthUrl).generate();

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/mfa/setup-confirm',
      headers: { authorization: `Bearer ${token}` },
      payload: { code },
    });
    expect(confirm.statusCode).toBe(200);
    expect((confirm.json().data as { ok: boolean }).ok).toBe(true);

    const status = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/mfa/status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((status.json().data as { enabled: boolean }).enabled).toBe(true);
  });
});
