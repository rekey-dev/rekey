/**
 * Regressions for the end-user / API-surface half of the 2026-08-02 auth review.
 *
 *   2.  /auth/mfa/setup reset `enrolledAt` with no step-up, which reached the
 *       same end as /mfa/disable without passing its guard.
 *   3.  Both passkey ceremonies asked for user verification as "preferred" and
 *       verified with the requirement off, while passkey auth mints a session
 *       directly — so a UV=0 assertion downgraded password + TOTP to a touch.
 *   4.  Organization invitations were not bound to the invited email: any
 *       authenticated account could accept an OWNER invite.
 *   5.  `impersonation_audits.endedAt` was never written, so an impersonation
 *       session could not be revoked, and it could rebind the victim's MFA.
 *   9.  An unknown `eventKey` on the email test-send route was a 500.
 *   10. `/api/v1/me` omitted the required `environment` field and returned raw
 *       Prisma JSON for the two config objects.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const PASSWORD = 'pw-one-two-three';

interface Fixture {
  operatorToken: string;
  applicationId: string;
  liveKey: string;
  publicKey: string;
  endUserId: string;
  endUserToken: string;
  endUserEmail: string;
}

describe('end-user auth hardening', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  async function bootstrap(label: string): Promise<Fixture> {
    const tag = `${label}-${++n}-${Math.random().toString(36).slice(2, 7)}`;
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

    // Enable MFA + organizations + passkeys on the Application so the routes
    // under test are reachable at all.
    await prisma.application.update({
      where: { id: application.id },
      data: {
        authConfig: {
          methods: ['password', 'passkey'],
          passwordMinLength: 8,
          redirectUrls: [],
          organizationsEnabled: true,
          signupEnabled: true,
          passwordBreachCheckEnabled: false,
          mfa: 'optional',
          webauthn: { rpId: 'localhost', rpOrigins: ['http://localhost:3030'], rpName: 'T' },
        } as never,
      },
    });

    const endUserEmail = `eu-${tag}@example.com`;
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: endUserEmail, password: PASSWORD },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });

    return {
      operatorToken: op.accessToken,
      applicationId: application.id,
      liveKey,
      publicKey: application.publicKey,
      endUserId: eu.endUser.id,
      endUserToken: eu.accessToken,
      endUserEmail,
    };
  }

  /** Enroll TOTP for an end-user via the publishable surface. */
  async function enrollMfa(f: Fixture): Promise<() => string> {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup',
      headers: {
        authorization: `Bearer ${f.publicKey}`,
        'x-rekey-user-token': f.endUserToken,
      },
    });
    expect(setup.statusCode).toBe(201);
    const totp = OTPAuth.URI.parse((setup.json().data as { otpauthUrl: string }).otpauthUrl);
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup-confirm',
      headers: {
        authorization: `Bearer ${f.publicKey}`,
        'x-rekey-user-token': f.endUserToken,
      },
      payload: { code: totp.generate() },
    });
    expect(confirm.statusCode).toBe(200);
    return () => totp.generate();
  }

  // ── Finding 2 ────────────────────────────────────────────────────────────
  describe('MFA is not removable with a stolen token via /mfa/setup', () => {
    it('a browser caller cannot re-enroll over an enrolled authenticator without a code', async () => {
      const f = await bootstrap('mfa-setup');
      const code = await enrollMfa(f);

      const rebind = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: {
          authorization: `Bearer ${f.publicKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
      });
      // Was 201 with a fresh secret and `enrolledAt: null` — the account's real
      // authenticator silently stopped counting, which is what /mfa/disable
      // demands a code to prevent.
      expect(rebind.statusCode).toBe(401);
      expect(rebind.json().error.code).toBe('MFA_CODE_INVALID');

      const status = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/mfa/status',
        headers: {
          authorization: `Bearer ${f.publicKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
      });
      expect((status.json().data as { enabled: boolean }).enabled).toBe(true);

      const allowed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: {
          authorization: `Bearer ${f.publicKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
        payload: { code: code() },
      });
      expect(allowed.statusCode).toBe(201);
    });

    it('a SECRET-key caller keeps the previous contract', async () => {
      const f = await bootstrap('mfa-secret');
      await enrollMfa(f);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: {
          authorization: `Bearer ${f.liveKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
      });
      // The customer's backend is the trusted gate — same split /mfa/disable
      // already makes. Changing this would break published SDK signatures.
      expect(res.statusCode).toBe(201);
    });
  });

  // ── Finding 3 ────────────────────────────────────────────────────────────
  describe('passkey ceremonies require user verification', () => {
    it('authenticate/start asks for it — a UV=0 assertion is not a sign-in', async () => {
      const f = await bootstrap('pk-uv');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/authenticate/start',
        headers: { authorization: `Bearer ${f.publicKey}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const { options } = res.json().data as { options: { userVerification: string } };
      // Was 'preferred', and the verifier passed `requireUserVerification: false`
      // — so an authenticator that skipped the PIN/biometric still produced a
      // full session via `issuePair`, replacing password + TOTP with a touch.
      expect(options.userVerification).toBe('required');
    });

    it('register/start asks for it too, so nothing weaker can be enrolled', async () => {
      const f = await bootstrap('pk-uv-reg');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/register/start',
        headers: {
          authorization: `Bearer ${f.liveKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
      });
      expect(res.statusCode).toBe(200);
      const { options } = res.json().data as {
        options: { authenticatorSelection: { userVerification: string } };
      };
      expect(options.authenticatorSelection.userVerification).toBe('required');
    });
  });

  // ── Finding 4 ────────────────────────────────────────────────────────────
  describe('organization invitations are bound to the invited email', () => {
    it('an unrelated account cannot accept an OWNER invite', async () => {
      const f = await bootstrap('orginv');

      const org = await app
        .inject({
          method: 'POST',
          url: '/api/v1/users/me/organizations/',
          headers: {
            authorization: `Bearer ${f.liveKey}`,
            'x-rekey-user-token': f.endUserToken,
          },
          payload: { name: 'Acme', slug: `acme-${Math.random().toString(36).slice(2, 8)}` },
        })
        .then((r) => (r.json().data as { organization: { id: string } }).organization);

      const invitedEmail = `invited-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const invite = await app.inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${org.id}/invitations`,
        headers: {
          authorization: `Bearer ${f.liveKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
        payload: { email: invitedEmail, role: 'OWNER' },
      });
      expect(invite.statusCode, invite.body).toBe(201);
      const rawToken = (invite.json().data as { token: string }).token;

      // A completely unrelated account in the same Application — the reviewer's
      // exact scenario: they held the link, not the mailbox.
      const stranger = await app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${f.liveKey}` },
          payload: {
            email: `stranger-${Math.random().toString(36).slice(2, 8)}@example.com`,
            password: PASSWORD,
          },
        })
        .then((r) => r.json().data as { accessToken: string });

      const stolen = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/organizations/accept-invitation',
        headers: {
          authorization: `Bearer ${f.liveKey}`,
          'x-rekey-user-token': stranger.accessToken,
        },
        payload: { token: rawToken },
      });
      // Was 200 with an OWNER membership on somebody else's organization.
      expect(stolen.statusCode).toBe(403);
      expect(stolen.json().error.code).toBe('ORGANIZATION_INVITATION_EMAIL_MISMATCH');
      expect(
        await prisma.organizationMembership.count({ where: { organizationId: org.id } }),
      ).toBe(1);

      // The invited address still works — the token was not burned by the
      // refused attempt.
      const invited = await app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${f.liveKey}` },
          payload: { email: invitedEmail, password: PASSWORD },
        })
        .then((r) => r.json().data as { accessToken: string });
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/organizations/accept-invitation',
        headers: {
          authorization: `Bearer ${f.liveKey}`,
          'x-rekey-user-token': invited.accessToken,
        },
        payload: { token: rawToken },
      });
      expect(accepted.statusCode).toBe(200);
    });
  });

  // ── Finding 5 ────────────────────────────────────────────────────────────
  describe('impersonation is revocable and cannot rebind credentials', () => {
    async function impersonate(f: Fixture): Promise<{ token: string; impersonationId: string }> {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${f.applicationId}/end-users/${f.endUserId}/impersonate`,
        headers: { authorization: `Bearer ${f.operatorToken}` },
        payload: { reason: 'support' },
      });
      expect(res.statusCode).toBe(200);
      const d = res.json().data as { accessToken: string; impersonationId: string };
      return { token: d.accessToken, impersonationId: d.impersonationId };
    }

    it('ending the session writes endedAt AND kills the token', async () => {
      const f = await bootstrap('imp-end');
      const { token, impersonationId } = await impersonate(f);

      // Live to start with.
      const before = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/',
        headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': token },
      });
      expect(before.statusCode).toBe(200);

      const ended = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${f.applicationId}/end-users/${f.endUserId}/impersonate/end`,
        headers: { authorization: `Bearer ${f.operatorToken}` },
      });
      expect(ended.statusCode).toBe(200);
      expect((ended.json().data as { ended: number }).ended).toBe(1);

      // `endedAt` was documented in prisma/schema.prisma and written by no code
      // path at all — this is the first thing that writes it.
      const row = await prisma.impersonationAudit.findUniqueOrThrow({
        where: { id: impersonationId },
      });
      expect(row.endedAt).not.toBeNull();

      // And it is a revocation, not an annotation: the minted token stops
      // working immediately, well inside its 5-minute life.
      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/',
        headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': token },
      });
      expect(after.statusCode).toBe(401);
      expect(after.json().error.code).toBe('IMPERSONATION_SESSION_ENDED');
    });

    it('cannot rebind the victim\'s MFA, passkeys, or password', async () => {
      const f = await bootstrap('imp-cred');
      const { token } = await impersonate(f);

      const asImpersonator = (method: 'POST' | 'DELETE', url: string, payload?: unknown) =>
        app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': token },
          ...(payload !== undefined ? { payload } : {}),
        } as never);

      const mfaSetup = await asImpersonator('POST', '/api/v1/auth/mfa/setup');
      // Was 201: a 5-minute support session could bind the account's second
      // factor to an authenticator the operator controls, permanently.
      expect(mfaSetup.statusCode).toBe(403);
      expect(mfaSetup.json().error.code).toBe('IMPERSONATION_ACTION_FORBIDDEN');

      const mfaDisable = await asImpersonator('POST', '/api/v1/auth/mfa/disable');
      expect(mfaDisable.statusCode).toBe(403);

      const passkey = await asImpersonator('POST', '/api/v1/auth/passkey/register/start');
      expect(passkey.statusCode).toBe(403);

      const password = await asImpersonator('POST', '/api/v1/auth/change-password', {
        currentPassword: PASSWORD,
        newPassword: 'operator-chose-this-one',
      });
      expect(password.statusCode).toBe(403);

      // The password really did not change.
      const stillWorks = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${f.liveKey}` },
        payload: { email: f.endUserEmail, password: PASSWORD },
      });
      expect(stillWorks.statusCode).toBe(200);

      // Reads are untouched — support work is what impersonation is for.
      const read = await asImpersonator('POST', '/api/v1/auth/mfa/setup');
      expect(read.statusCode).toBe(403);
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/',
        headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': token },
      });
      expect(me.statusCode).toBe(200);
    });

    it('an ordinary end-user session is unaffected by any of it', async () => {
      const f = await bootstrap('imp-normal');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: {
          authorization: `Bearer ${f.liveKey}`,
          'x-rekey-user-token': f.endUserToken,
        },
      });
      expect(res.statusCode).toBe(201);
    });
  });

  // ── Finding 9 ────────────────────────────────────────────────────────────
  describe('an unknown email eventKey is client error, not server error', () => {
    it('test-send and preview refuse with 404, not 500', async () => {
      const f = await bootstrap('emailkey');
      for (const [url, payload] of [
        [`/api/v1/tenant/applications/${f.applicationId}/email-templates/not_a_real_event/test-send`, { to: 'x@example.com' }],
        [`/api/v1/tenant/applications/${f.applicationId}/email-templates/not_a_real_event/preview`, {}],
      ] as const) {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: { authorization: `Bearer ${f.operatorToken}` },
          payload,
        });
        // Was 500 INTERNAL_ERROR from a bare `throw new Error` on a path
        // segment the caller chose. Matches the code the sibling GET/PUT
        // routes on the same param already return.
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('EMAIL_EVENT_UNKNOWN');
      }
    });
  });

  // ── Finding 10 ───────────────────────────────────────────────────────────
  describe('GET /me matches ApplicationDto', () => {
    it('sends `environment` and schema-parsed config objects', async () => {
      const f = await bootstrap('medto');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me/',
        headers: { authorization: `Bearer ${f.liveKey}` },
      });
      expect(res.statusCode).toBe(200);
      const data = res.json().data as {
        environment?: string;
        authConfig: Record<string, unknown>;
        billingConfig: Record<string, unknown>;
      };
      // `environment` is REQUIRED in ApplicationDtoSchema and was never sent:
      // the documented SDK smoke test returned `undefined` typed as an enum.
      expect(data.environment).toBeDefined();
      expect(['PRODUCTION', 'STAGING', 'DEVELOPMENT']).toContain(data.environment);
      // The configs were passed through as raw Prisma JSON typed `unknown`, so
      // AuthConfigSchema's defaults never ran. Parsed output always carries
      // these, whatever the stored row happens to contain.
      expect(typeof data.authConfig.passwordMinLength).toBe('number');
      expect(Array.isArray(data.authConfig.methods)).toBe(true);
      expect(data.billingConfig).toHaveProperty('enabled');

      // And the whole payload validates against the published schema.
      const { ApplicationDtoSchema } = await import('@rekey.dev/shared-types');
      expect(() => ApplicationDtoSchema.parse(data)).not.toThrow();
    });
  });
});
