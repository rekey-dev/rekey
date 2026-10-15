/**
 * Operator MFA cannot be removed or replaced with a stolen session alone:
 * disable needs a factor, and setup over an enrolled authenticator needs a
 * current code.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { buildApp } from '../src/app.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const PASSWORD = 'pw-one-two-three';

describe('operator MFA removal', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  // The global limiter is per-IP (100/min) and the instance lives for the whole
  // file; a few of these tests fire ten sign-ins in a row, so give each its own
  // source address.
  let ipCounter = 0;
  function freshIp(): string {
    return `10.44.${++ipCounter}.1`;
  }

  async function signUp(
    email: string,
    ip: string,
  ): Promise<{ accessToken: string; userId: string; tenantId: string }> {
    const r = await app.inject({
      remoteAddress: ip,
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: PASSWORD, workspaceName: 'WS' },
    });
    expect(r.statusCode).toBe(201);
    const d = r.json().data as {
      accessToken: string;
      user: { id: string };
      activeTenantId: string;
    };
    return { accessToken: d.accessToken, userId: d.user.id, tenantId: d.activeTenantId };
  }

  /** Enroll TOTP for an operator and return a generator for live codes. */
  async function enrollMfa(accessToken: string): Promise<() => string> {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/mfa/setup',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(setup.statusCode).toBe(201);
    const { otpauthUrl } = setup.json().data as { otpauthUrl: string };
    const totp = OTPAuth.URI.parse(otpauthUrl);
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/mfa/setup-confirm',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { code: totp.generate() },
    });
    expect(confirm.statusCode).toBe(200);
    // The confirming code spent this step (lib/mfa-replay.ts), so later proofs use the next one.
    return () => totp.generate({ timestamp: Date.now() + 30_000 });
  }

  describe('operator MFA cannot be removed with a stolen session alone', () => {
    it('/mfa/disable refuses with no factor, and refuses the account password', async () => {
      const ip = freshIp();
      const op = await signUp(`opmfa-d-${Math.random().toString(36).slice(2, 8)}@example.com`, ip);
      const code = await enrollMfa(op.accessToken);

      const bare = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/disable',
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
      // Was 200 { disabled: true }, a session was the whole requirement.
      expect(bare.statusCode).toBe(401);
      expect(bare.json().error.code).toBe('STEP_UP_REQUIRED');

      const withPassword = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/disable',
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: { password: PASSWORD },
      });
      // Deliberately not enough: someone holding a stolen session AND the
      // password is exactly who the second factor exists to stop.
      expect(withPassword.statusCode).toBe(401);

      const stillOn = await app.inject({
        remoteAddress: ip,
        method: 'GET',
        url: '/api/v1/tenant/auth/mfa/status',
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
      expect((stillOn.json().data as { enabled: boolean }).enabled).toBe(true);

      const withCode = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/disable',
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: { code: code() },
      });
      expect(withCode.statusCode).toBe(200);
    });

    it('/mfa/setup cannot re-enroll over an enrolled authenticator without a current code', async () => {
      const ip = freshIp();
      const op = await signUp(`opmfa-s-${Math.random().toString(36).slice(2, 8)}@example.com`, ip);
      const code = await enrollMfa(op.accessToken);

      const rebind = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/setup',
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
      // Was 201 with a fresh secret AND `enrolledAt: null`, the disable guard
      // routed around, one endpoint to the left.
      expect(rebind.statusCode).toBe(401);
      expect(rebind.json().error.code).toBe('STEP_UP_REQUIRED');

      // The existing enrollment survived the attempt.
      const status = await app.inject({
        remoteAddress: ip,
        method: 'GET',
        url: '/api/v1/tenant/auth/mfa/status',
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
      expect((status.json().data as { enabled: boolean }).enabled).toBe(true);

      // With a current code it is an ordinary re-enrolment.
      const allowed = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/setup',
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: { code: code() },
      });
      expect(allowed.statusCode).toBe(201);
    });

    it('first-time setup still requires nothing', async () => {
      const ip = freshIp();
      const op = await signUp(`opmfa-f-${Math.random().toString(36).slice(2, 8)}@example.com`, ip);
      const first = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/setup',
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
      expect(first.statusCode).toBe(201);
    });
  });

});
