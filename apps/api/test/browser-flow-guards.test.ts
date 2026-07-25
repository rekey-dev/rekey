/**
 * Browser-reachability of end-user self-service flows.
 *
 * A route-guard audit found several flows gated on `requireApiKey` (SECRET key
 * only) where the real authorizer was already `requireUserSession` — the
 * end-user JWT, which is bound to the Application and enforces test/live
 * isolation. The secret tier added no authorization the session didn't carry;
 * it only forbade the one credential a browser is allowed to hold (`rp_pub_*`),
 * making the flow unreachable from `@relipay/react` and asymmetric with its own
 * siblings (MFA challenge but no MFA enrollment; passkey sign-in but no passkey
 * enrollment; create/list invites but never accept one; …).
 *
 * The two properties every case below asserts:
 *   1. publishable key + user token → the flow WORKS.
 *   2. publishable key + NO user token → 401 USER_TOKEN_MISSING. This is the
 *      boundary that matters: the session, not the key tier, is the gate. A
 *      publishable key alone must never reach an end-user-scoped route.
 *
 * Plus two non-key fixes from the same audit:
 *   - PAT revocation must not need more privilege than minting did.
 *   - GET-only billing routes must accept a narrow `billing:read` key.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import * as OTPAuth from 'otpauth';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const PASSWORD = 'pw-one-two-three';

describe('browser-reachable end-user self-service flows', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  interface Ctx {
    applicationId: string;
    publicKey: string;
    liveKey: string;
    userToken: string;
    userId: string;
    userEmail: string;
  }
  let ctx: Ctx;

  /** Admin-route bootstrap: the create response is the only place the raw
   *  publishable key and raw secret key are both handed back. */
  async function bootstrap(): Promise<Ctx> {
    const slug = `bfg-${Math.random().toString(36).slice(2, 8)}`;
    /** Surface the response body on a failed fixture call. Without this a 429 or
     *  400 here shows up as "Cannot read properties of undefined (reading 'id')"
     *  several lines later, which says nothing about the actual cause. */
    const created = <T>(res: { statusCode: number; json: () => { data?: T } }, what: string): T => {
      if (res.statusCode >= 300) {
        throw new Error(`fixture ${what} failed: ${res.statusCode} ${JSON.stringify(res.json())}`);
      }
      return res.json().data as T;
    };

    const tenant = created<{ id: string }>(
      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: `T ${slug}`, ownerEmail: `op-${slug}@example.com` },
      }),
      'tenant',
    );

    const application = created<{ id: string; publicKey: string }>(
      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: `A ${slug}`, slug, enableBilling: true },
      }),
      'application',
    );
    expect(application.publicKey.startsWith('rp_pub_')).toBe(true);

    // Organizations are opt-in per Application; MFA defaults to 'optional'
    // (enrollment allowed) so it needs no flip here.
    await prisma.application.update({
      where: { id: application.id },
      data: {
        authConfig: {
          methods: ['password'],
          passwordMinLength: 8,
          redirectUrls: [],
          organizationsEnabled: true,
          signupEnabled: true,
          passwordBreachCheckEnabled: false,
        } as never,
      },
    });

    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    const userEmail = `eu-${slug}@example.com`;
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${application.publicKey}` },
        payload: { email: userEmail, password: PASSWORD },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });

    return {
      applicationId: application.id,
      publicKey: application.publicKey,
      liveKey,
      userToken: eu.accessToken,
      userId: eu.endUser.id,
      userEmail,
    };
  }

  beforeEach(async () => {
    ctx = await bootstrap();
  });

  /** Call with the publishable key AND the end-user token — the browser shape. */
  const asBrowser = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
    token = ctx.userToken,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${ctx.publicKey}`, 'x-relipay-user-token': token },
      ...(payload !== undefined && { payload }),
    });

  /** Call with the publishable key and NO user token — must always be refused. */
  const asAnonBrowser = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${ctx.publicKey}` },
      ...(payload !== undefined && { payload }),
    });

  function expectNoSessionRefused(res: { statusCode: number; json: () => { error: { code: string } } }): void {
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('USER_TOKEN_MISSING');
  }

  // ------------------------------------------------------------------
  // 1. Organization accept-invitation (sibling: create/list invitations)
  // ------------------------------------------------------------------

  describe('POST /auth/organizations/accept-invitation', () => {
    it('accepts an invitation with a publishable key + invitee token', async () => {
      const org = await asBrowser('POST', '/api/v1/users/me/organizations/', {
        name: 'Acme',
        slug: 'acme',
      }).then((r) => r.json().data as { organization: { id: string } });

      const inviteeEmail = `invitee-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const invitee = await app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${ctx.publicKey}` },
          payload: { email: inviteeEmail, password: PASSWORD },
        })
        .then((r) => r.json().data as { accessToken: string });

      // Creating the invite already accepted the publishable key before this fix.
      const inv = await asBrowser(
        'POST',
        `/api/v1/users/me/organizations/${org.organization.id}/invitations`,
        { email: inviteeEmail, role: 'ADMIN' },
      ).then((r) => r.json().data as { token: string });

      // Accepting it did not — the flow dead-ended here.
      const accept = await asBrowser(
        'POST',
        '/api/v1/auth/organizations/accept-invitation',
        { token: inv.token },
        invitee.accessToken,
      );
      expect(accept.statusCode).toBe(200);
      expect((accept.json().data as { membership: { role: string } }).membership.role).toBe('ADMIN');
    });

    it('401 USER_TOKEN_MISSING with a publishable key and no user token', async () => {
      expectNoSessionRefused(
        await asAnonBrowser('POST', '/api/v1/auth/organizations/accept-invitation', {
          token: 'whatever-token-value',
        }),
      );
    });
  });

  // ------------------------------------------------------------------
  // 2. MFA (sibling: POST /auth/mfa-verify, the sign-in challenge)
  // ------------------------------------------------------------------

  describe('/auth/mfa/*', () => {
    it('status + setup + disable work with a publishable key + user token', async () => {
      const status = await asBrowser('GET', '/api/v1/auth/mfa/status');
      expect(status.statusCode).toBe(200);
      expect((status.json().data as { enabled: boolean }).enabled).toBe(false);

      // The asymmetry that mattered: a browser-only app could be CHALLENGED for
      // MFA (mfa-verify already took the publishable key) but never ENROLL.
      const setup = await asBrowser('POST', '/api/v1/auth/mfa/setup');
      expect(setup.statusCode).toBe(201);
      expect((setup.json().data as { otpauthUrl: string }).otpauthUrl).toContain('otpauth://');

      // Enrollment was only STARTED, so nothing is enrolled yet and cancelling
      // it needs no factor — disable stays the successful no-op it always was.
      const disable = await asBrowser('POST', '/api/v1/auth/mfa/disable');
      expect(disable.statusCode).toBe(200);
    });

    it('a browser cannot disable ENROLLED MFA without a current factor', async () => {
      // The step-up. Publishable + user token is enough to reach the route, but
      // once a credential is actually enrolled a stolen access token must not be
      // able to switch off the control that exists to survive token theft.
      const setup = await asBrowser('POST', '/api/v1/auth/mfa/setup');
      const otpauthUrl = (setup.json().data as { otpauthUrl: string }).otpauthUrl;
      const secret = new URL(otpauthUrl.replace('otpauth://', 'https://x/')).searchParams.get(
        'secret',
      )!;
      const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });

      const confirm = await asBrowser('POST', '/api/v1/auth/mfa/setup-confirm', {
        code: totp.generate(),
      });
      expect(confirm.statusCode).toBe(200);

      const noCode = await asBrowser('POST', '/api/v1/auth/mfa/disable');
      expect(noCode.statusCode).toBe(401);
      expect((noCode.json().error as { code: string }).code).toBe('MFA_CODE_INVALID');

      const wrongCode = await asBrowser('POST', '/api/v1/auth/mfa/disable', { code: '000000' });
      expect(wrongCode.statusCode).toBe(401);

      const withCode = await asBrowser('POST', '/api/v1/auth/mfa/disable', {
        code: totp.generate(),
      });
      expect(withCode.statusCode).toBe(200);
    });

    it('a secret-key caller keeps the no-code contract on enrolled MFA', async () => {
      // Server-side integrators call disableMfa(accessToken) with no code
      // (packages/sdk-node). Their backend is the trusted gate, so requiring one
      // universally would have broken a published SDK signature.
      const setup = await asBrowser('POST', '/api/v1/auth/mfa/setup');
      const otpauthUrl = (setup.json().data as { otpauthUrl: string }).otpauthUrl;
      const secret = new URL(otpauthUrl.replace('otpauth://', 'https://x/')).searchParams.get(
        'secret',
      )!;
      const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
      await asBrowser('POST', '/api/v1/auth/mfa/setup-confirm', { code: totp.generate() });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/disable',
        headers: { authorization: `Bearer ${ctx.liveKey}`, 'x-relipay-user-token': ctx.userToken },
      });
      expect(res.statusCode).toBe(200);
    });

    it('401 USER_TOKEN_MISSING for every MFA route with no user token', async () => {
      expectNoSessionRefused(await asAnonBrowser('GET', '/api/v1/auth/mfa/status'));
      expectNoSessionRefused(await asAnonBrowser('POST', '/api/v1/auth/mfa/setup'));
      expectNoSessionRefused(
        await asAnonBrowser('POST', '/api/v1/auth/mfa/setup-confirm', { code: '000000' }),
      );
      expectNoSessionRefused(
        await asAnonBrowser('POST', '/api/v1/auth/mfa/challenge', { code: '000000' }),
      );
      expectNoSessionRefused(await asAnonBrowser('POST', '/api/v1/auth/mfa/disable'));
    });
  });

  // ------------------------------------------------------------------
  // 3. Authenticated auth management (siblings: passkey authenticate,
  //    verify-email, forgot/reset-password)
  // ------------------------------------------------------------------

  describe('authenticated /auth/* management routes', () => {
    it('sessions, passkeys, send-verification and change-password work from a browser', async () => {
      const sessions = await asBrowser('GET', '/api/v1/auth/sessions');
      expect(sessions.statusCode).toBe(200);
      expect(Array.isArray(sessions.json().data)).toBe(true);

      // A browser could sign in WITH a passkey but never enroll one.
      const passkeys = await asBrowser('GET', '/api/v1/auth/passkeys');
      expect(passkeys.statusCode).toBe(200);
      expect(passkeys.json().data).toEqual([]);

      // It could consume a verification token but never request one.
      const sendVerification = await asBrowser('POST', '/api/v1/auth/send-verification', {});
      expect(sendVerification.statusCode).toBe(200);

      const changePassword = await asBrowser('POST', '/api/v1/auth/change-password', {
        currentPassword: PASSWORD,
        newPassword: 'pw-four-five-six',
      });
      expect(changePassword.statusCode).toBe(200);
    });

    it('passkey registration stays SECRET-key only, unlike its siblings', async () => {
      // The deliberate exception to this whole file. Every other flow here moved
      // to the publishable key because the end-user session was already the real
      // authorizer. Passkey ENROLLMENT did not, because a passkey bypasses the
      // MFA challenge: a stolen access token that can enroll one buys persistent
      // account takeover that neither a password change nor sign-out-everywhere
      // revokes. So a browser is refused on the credential, by design.
      const browser = await asBrowser('POST', '/api/v1/auth/passkey/register/start', {});
      expect(browser.statusCode).toBe(401);
      expect(browser.json().error.code).toBe('API_KEY_INVALID');

      // A secret key reaches the route and fails on CONFIG instead, proving the
      // 401 above is the key tier talking and not a broken route.
      const server = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/register/start',
        headers: { authorization: `Bearer ${ctx.liveKey}`, 'x-relipay-user-token': ctx.userToken },
        payload: {},
      });
      expect(server.statusCode).toBe(400);
      expect(server.json().error.code).toBe('WEBAUTHN_NOT_CONFIGURED');
    });

    it('401 USER_TOKEN_MISSING for every management route with no user token', async () => {
      expectNoSessionRefused(await asAnonBrowser('GET', '/api/v1/auth/sessions'));
      expectNoSessionRefused(await asAnonBrowser('GET', '/api/v1/auth/passkeys'));
      expectNoSessionRefused(await asAnonBrowser('POST', '/api/v1/auth/send-verification', {}));
      expectNoSessionRefused(await asAnonBrowser('POST', '/api/v1/auth/sign-out-everywhere'));
      expectNoSessionRefused(await asAnonBrowser('DELETE', '/api/v1/auth/sessions/some-id'));
      expectNoSessionRefused(await asAnonBrowser('DELETE', '/api/v1/auth/passkeys/some-id'));
      expectNoSessionRefused(
        await asAnonBrowser('POST', '/api/v1/auth/passkey/register/start', {}),
      );
      expectNoSessionRefused(
        await asAnonBrowser('POST', '/api/v1/auth/change-password', {
          currentPassword: PASSWORD,
          newPassword: 'pw-four-five-six',
        }),
      );
    });
  });

  // ------------------------------------------------------------------
  // 4. OAuth identity linking (siblings: /:provider/start + /callback)
  // ------------------------------------------------------------------

  describe('/auth/oauth link routes', () => {
    it('GET /identities works with a publishable key + user token', async () => {
      const res = await asBrowser('GET', '/api/v1/auth/oauth/identities');
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
    });

    it('link/start is reachable from a browser (fails on provider config, not credential)', async () => {
      // No Google OAuth config on this app, so this refuses on the provider —
      // previously it never got that far, refused on the key tier instead.
      const res = await asBrowser('POST', '/api/v1/auth/oauth/google/link/start', {
        state: 'csrf-state-value',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('OAUTH_PROVIDER_NOT_CONFIGURED');
    });

    it('401 USER_TOKEN_MISSING for link routes with no user token', async () => {
      expectNoSessionRefused(await asAnonBrowser('GET', '/api/v1/auth/oauth/identities'));
      expectNoSessionRefused(
        await asAnonBrowser('POST', '/api/v1/auth/oauth/google/link/start', { state: 's' }),
      );
      expectNoSessionRefused(
        await asAnonBrowser('POST', '/api/v1/auth/oauth/google/link/complete', { code: 'c' }),
      );
      expectNoSessionRefused(await asAnonBrowser('DELETE', '/api/v1/auth/oauth/google'));
    });
  });

  // ------------------------------------------------------------------
  // 5. Coupon validate (sibling: POST /billing/checkout, same couponCode)
  // ------------------------------------------------------------------

  describe('POST /billing/coupons/validate', () => {
    beforeEach(async () => {
      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${ctx.applicationId}/plans`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { slug: 'pro_monthly', name: 'Pro', amount: 999 },
      });
      await app.inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${ctx.applicationId}/coupons`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { code: 'fifteen', discountType: 'PERCENT', amountOff: 1500 },
      });
    });

    it('a pricing page validates a coupon with a publishable key + user token', async () => {
      const res = await asBrowser('POST', '/api/v1/billing/coupons/validate', {
        code: 'FIFTEEN',
        planSlug: 'pro_monthly',
      });
      expect(res.statusCode).toBe(200);
      const data = res.json().data as { discountAmount: number };
      expect(data.discountAmount).toBe(149);
    });

    it('401 USER_TOKEN_MISSING with a publishable key and no user token', async () => {
      expectNoSessionRefused(
        await asAnonBrowser('POST', '/api/v1/billing/coupons/validate', {
          code: 'FIFTEEN',
          planSlug: 'pro_monthly',
        }),
      );
    });

    it('still keeps the billing:read scope requirement for secret keys', async () => {
      const authOnlyKey = await app
        .inject({
          method: 'POST',
          url: `/api/v1/admin/applications/${ctx.applicationId}/api-keys`,
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { name: 'auth-only', mode: 'live', scopes: ['auth:read'] },
        })
        .then((r) => (r.json().data as { rawKey: string }).rawKey);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/coupons/validate',
        headers: { authorization: `Bearer ${authOnlyKey}`, 'x-relipay-user-token': ctx.userToken },
        payload: { code: 'FIFTEEN', planSlug: 'pro_monthly' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
    });
  });

  // ------------------------------------------------------------------
  // 6b. Profile reads: /users/me is browser-tier, /me is not
  // ------------------------------------------------------------------

  describe('GET /users/me vs GET /me', () => {
    it('a browser can read its own profile with a publishable key + user token', async () => {
      const res = await asBrowser('GET', '/api/v1/users/me');
      expect(res.statusCode).toBe(200);
      const body = res.json().data as { id: string; email: string };
      expect(body.id).toBe(ctx.userId);
      expect(body.email).toBe(ctx.userEmail);
    });

    it('never returns the password hash', async () => {
      // `authService.getById` redacts it, and this route spreads the whole
      // record — so the redaction is the only thing standing between a browser
      // and an Argon2id hash. Pin it here rather than trusting the type alias.
      const res = await asBrowser('GET', '/api/v1/users/me');
      expect(Object.keys(res.json().data as object)).not.toContain('passwordHash');
    });

    it('401 USER_TOKEN_MISSING with a publishable key and no user token', async () => {
      expectNoSessionRefused(await asAnonBrowser('GET', '/api/v1/users/me'));
    });

    it('GET /me stays secret-key-only — it returns operator config, not user data', async () => {
      // The response carries the Application's whole authConfig and
      // billingConfig. Those are operator configuration, so a browser-shipped
      // key must not reach them even though the sibling route above is open.
      const browser = await asBrowser('GET', '/api/v1/me');
      expect(browser.statusCode).toBe(401);
      expect(browser.json().error.code).toBe('API_KEY_INVALID');

      const server = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${ctx.liveKey}` },
      });
      expect(server.statusCode).toBe(200);
      expect((server.json().data as { id: string }).id).toBe(ctx.applicationId);
    });
  });

  // ------------------------------------------------------------------
  // 7. Read-scope corrections on GET-only billing routes
  // ------------------------------------------------------------------

  describe('billing:read on GET-only credits/usage routes', () => {
    let readKey: string;
    let writeKey: string;

    beforeEach(async () => {
      const mint = (name: string, scopes: string[]) =>
        app
          .inject({
            method: 'POST',
            url: `/api/v1/admin/applications/${ctx.applicationId}/api-keys`,
            headers: { authorization: `Bearer ${ADMIN_KEY}` },
            payload: { name, mode: 'live', scopes },
          })
          .then((r) => (r.json().data as { rawKey: string }).rawKey);
      readKey = await mint('read-only', ['billing:read']);
      writeKey = await mint('write', ['billing:write']);
      // /aggregate 404s on an unknown meter; create one so a 200 proves the
      // scope gate passed rather than the meter lookup short-circuiting.
      await prisma.usageMeter.create({
        data: { applicationId: ctx.applicationId, slug: 'scans', name: 'Scans', unit: 'scan' },
      });
    });

    const get = (url: string, key: string) =>
      app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });

    it('a billing:read key can read balance, ledger and usage aggregate', async () => {
      expect((await get(`/api/v1/credits/balance?endUserId=${ctx.userId}`, readKey)).statusCode).toBe(200);
      expect((await get(`/api/v1/credits/ledger?endUserId=${ctx.userId}`, readKey)).statusCode).toBe(200);
      expect((await get('/api/v1/usage/aggregate?meterSlug=scans', readKey)).statusCode).toBe(200);
    });

    it('billing:write still reads them (write implies read in the hierarchy)', async () => {
      expect((await get(`/api/v1/credits/balance?endUserId=${ctx.userId}`, writeKey)).statusCode).toBe(200);
      expect((await get(`/api/v1/credits/ledger?endUserId=${ctx.userId}`, writeKey)).statusCode).toBe(200);
      expect((await get('/api/v1/usage/aggregate?meterSlug=scans', writeKey)).statusCode).toBe(200);
    });

    it('a billing:read key still cannot consume credits or record usage', async () => {
      const consume = await app.inject({
        method: 'POST',
        url: '/api/v1/credits/consume',
        headers: { authorization: `Bearer ${readKey}` },
        payload: { endUserId: ctx.userId, amount: 1 },
      });
      expect(consume.statusCode).toBe(403);
      expect(consume.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');

      const record = await app.inject({
        method: 'POST',
        url: '/api/v1/usage/record',
        headers: { authorization: `Bearer ${readKey}` },
        payload: { meterSlug: 'scans', quantity: 1 },
      });
      expect(record.statusCode).toBe(403);
      expect(record.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
    });

    it('credits/usage stay secret-only — a publishable key never reaches them', async () => {
      const res = await get(`/api/v1/credits/balance?endUserId=${ctx.userId}`, ctx.publicKey);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('API_KEY_INVALID');
    });
  });
});

// ------------------------------------------------------------------
// 6. Operator PAT revocation must not need more privilege than minting
// ------------------------------------------------------------------

describe('operator PAT revocation privilege', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('a MEMBER can revoke their OWN still-valid PAT (minted while ADMIN)', async () => {
    const slug = `patrev-${Math.random().toString(36).slice(2, 8)}`;
    const session = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-${slug}@example.com`,
          password: PASSWORD,
          workspaceName: `WS ${slug}`,
        },
      })
      .then(
        (r) =>
          r.json().data as { accessToken: string; activeTenantId: string; user: { id: string } },
      );

    const pat = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/api-tokens',
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { name: 'agent' },
      })
      .then((r) => (r.json().data as { apiToken: { id: string } }).apiToken.id);

    // Downgrade the operator to MEMBER. Their PAT is untouched and still valid,
    // and GET /api-tokens (never role-gated) still shows it.
    await prisma.tenantMembership.update({
      where: {
        tenantUserId_tenantId: {
          tenantUserId: session.user.id,
          tenantId: session.activeTenantId,
        },
      },
      data: { role: 'MEMBER' },
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json().data as Array<{ id: string }>).map((t) => t.id)).toContain(pat);

    // Previously 403 TENANT_ROLE_INSUFFICIENT — the operator could see a live
    // credential they had no way to kill. `revoke` is scoped to their own id,
    // so no extra privilege is needed (or reachable).
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/auth/api-tokens/${pat}`,
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(revoke.statusCode).toBe(200);
    expect((revoke.json().data as { revokedAt: string | null }).revokedAt).toBeTruthy();
  });

  it('a MEMBER still cannot MINT a PAT (that gate is unchanged)', async () => {
    const slug = `patmint-${Math.random().toString(36).slice(2, 8)}`;
    const session = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-${slug}@example.com`,
          password: PASSWORD,
          workspaceName: `WS ${slug}`,
        },
      })
      .then(
        (r) =>
          r.json().data as { accessToken: string; activeTenantId: string; user: { id: string } },
      );

    await prisma.tenantMembership.update({
      where: {
        tenantUserId_tenantId: {
          tenantUserId: session.user.id,
          tenantId: session.activeTenantId,
        },
      },
      data: { role: 'MEMBER' },
    });

    const mint = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { name: 'nope' },
    });
    expect(mint.statusCode).toBe(403);
    expect(mint.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
  });

  it("revoking another operator's PAT is a 404, not an authorization decision", async () => {
    const mk = async (tag: string) =>
      app
        .inject({
          method: 'POST',
          url: '/api/v1/tenant/auth/sign-up',
          payload: {
            email: `op-${tag}@example.com`,
            password: PASSWORD,
            workspaceName: `WS ${tag}`,
          },
        })
        .then((r) => r.json().data as { accessToken: string });

    const tag = Math.random().toString(36).slice(2, 8);
    const a = await mk(`pata-${tag}`);
    const b = await mk(`patb-${tag}`);

    const aToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/api-tokens',
        headers: { authorization: `Bearer ${a.accessToken}` },
        payload: { name: 'a-pat' },
      })
      .then((r) => (r.json().data as { apiToken: { id: string } }).apiToken.id);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/auth/api-tokens/${aToken}`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
