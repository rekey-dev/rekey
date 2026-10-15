/**
 * Enrolling an operator passkey needs a step-up, and passkey sign-in demands
 * user verification.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const PASSWORD = 'pw-one-two-three';

describe('operator passkey enrolment and sign-in', () => {
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

  describe('operator passkeys', () => {
    it('enrolment requires a step-up', async () => {
      const ip = freshIp();
      process.env.PANEL_WEBAUTHN_RP_ID = 'panel.test.invalid';
      process.env.PANEL_WEBAUTHN_RP_ORIGINS = 'https://panel.test.invalid';
      try {
        const op = await signUp(`oppk-${Math.random().toString(36).slice(2, 8)}@example.com`, ip);

        const bare = await app.inject({
          remoteAddress: ip,
          method: 'POST',
          url: '/api/v1/tenant/auth/passkeys/register/start',
          headers: { authorization: `Bearer ${op.accessToken}` },
        });
        // Was 201 with ceremony options, a panel access token was sufficient
        // to enroll a credential that signs its holder in forever after.
        expect(bare.statusCode).toBe(401);
        expect(bare.json().error.code).toBe('STEP_UP_REQUIRED');

        const proven = await app.inject({
          remoteAddress: ip,
          method: 'POST',
          url: '/api/v1/tenant/auth/passkeys/register/start',
          headers: { authorization: `Bearer ${op.accessToken}` },
          payload: { password: PASSWORD },
        });
        expect(proven.statusCode).toBe(200);
      } finally {
        delete process.env.PANEL_WEBAUTHN_RP_ID;
        delete process.env.PANEL_WEBAUTHN_RP_ORIGINS;
      }
    });

    it('the sign-in ceremony demands user verification, so a passkey is not a downgrade', async () => {
      process.env.PANEL_WEBAUTHN_RP_ID = 'panel.test.invalid';
      process.env.PANEL_WEBAUTHN_RP_ORIGINS = 'https://panel.test.invalid';
      try {
        const res = await app.inject({
          remoteAddress: freshIp(),
          method: 'POST',
          url: '/api/v1/tenant/auth/passkeys/authenticate/start',
        });
        expect(res.statusCode).toBe(200);
        const { options } = res.json().data as { options: { userVerification: string } };
        // Was 'preferred'. Completing this ceremony mints an operator session
        // outright, so a UV=0 assertion replaced password AND TOTP with a touch.
        expect(options.userVerification).toBe('required');
      } finally {
        delete process.env.PANEL_WEBAUTHN_RP_ID;
        delete process.env.PANEL_WEBAUTHN_RP_ORIGINS;
      }
    });
  });

});
