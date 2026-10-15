/**
 * An end user enrols TOTP: setup, confirm, and status then reports it enabled.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import * as OTPAuth from 'otpauth';
import { operatorsConfirmTheirEmail, endUsersConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();
endUsersConfirmTheirEmail();

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  endUserId: string;
  endUserAccess: string;
  tenantAccess: string;
}

describe('end-user MFA enrolment', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    // Tenant operator path (4.0).
    const tenantSession = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string; activeTenantId: string });

    // App via the tenant-scoped route.
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantSession.accessToken}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });

    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${tenantSession.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });

    // End-user via the public auth surface.
    const endUserSession = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${key.rawKey}` },
        payload: { email: `eu-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });

    return {
      applicationId: application.id,
      liveKey: key.rawKey,
      endUserId: endUserSession.endUser.id,
      endUserAccess: endUserSession.accessToken,
      tenantAccess: tenantSession.accessToken,
    };
  }
  it('MFA setup → confirm → status reports enabled', async () => {
    const b = await bootstrap('mfa');

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.endUserAccess,
      },
    });
    expect(setup.statusCode).toBe(201);
    const setupData = setup.json().data as { otpauthUrl: string; backupCodes: string[] };
    expect(setupData.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(setupData.backupCodes).toHaveLength(10);

    // Extract the secret from the otpauth URL and produce a valid current code.
    const url = new URL(setupData.otpauthUrl.replace('otpauth://', 'https://placeholder/'));
    const secret = url.searchParams.get('secret')!;
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6 });
    const code = totp.generate();

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup-confirm',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.endUserAccess,
      },
      payload: { code },
    });
    expect(confirm.statusCode).toBe(200);

    const status = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/mfa/status',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': b.endUserAccess,
      },
    });
    const sd = status.json().data as { enabled: boolean; remainingBackupCodes: number };
    expect(sd.enabled).toBe(true);
    expect(sd.remainingBackupCodes).toBe(10);
  });
});
