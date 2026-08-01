/**
 * Error codes whose *behaviour* mattered and was unasserted.
 *
 * The suite defines 234 distinct `code:` values and asserted about 60% of
 * them. Chasing the percentage would be busywork — most of the rest are
 * validation strings. These are the ones where the code is the contract: an
 * SDK, the panel, or a customer's own error handling branches on it, and
 * getting it wrong is a security or money outcome rather than a typo.
 *
 * Each case here also pins the *behaviour behind* the code, not just its
 * spelling — an expired magic link must not mint a session, a taken OAuth
 * identity must not be re-pointed, an inactive coupon must not discount.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { registerOAuthProvider } from '../src/modules/oauth/providers/index.js';
import { GoogleProvider } from '../src/modules/oauth/providers/google.js';
import { operatorTokensService } from '../src/modules/tenant-auth/operator-tokens.service.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface Bootstrapped {
  tenantId: string;
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
}

describe('uncovered error codes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    // The OAuth registry is process-global and this file overwrites 'google'.
    // singleFork shares it with every other file — restore it.
    registerOAuthProvider(new GoogleProvider());
    await app.close();
  });

  function rand(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  /** Operator workspace + Application + live API key, via the real routes. */
  async function bootstrap(
    prefix: string,
    authConfig?: Record<string, unknown>,
  ): Promise<Bootstrapped> {
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `${prefix}-${rand()}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: `${prefix} Co`,
      },
    });
    expect(signUp.statusCode).toBe(201);
    const session = signUp.json().data as { accessToken: string; activeTenantId: string };

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { name: prefix, slug: `${prefix}-${rand()}` },
    });
    expect(created.statusCode).toBe(201);
    const applicationId = (created.json().data as { id: string }).id;

    if (authConfig) {
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: authConfig,
      });
      expect(patched.statusCode).toBe(200);
    }

    const key = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/api-keys`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name: 'k', mode: 'live' },
    });
    expect(key.statusCode).toBe(201);

    return {
      tenantId: session.activeTenantId,
      applicationId,
      liveKey: (key.json().data as { rawKey: string }).rawKey,
      tenantAccess: session.accessToken,
    };
  }

  // ---------- MAGIC_LINK_EXPIRED ----------

  it('MAGIC_LINK_EXPIRED: an aged token is refused and mints no session', async () => {
    const b = await bootstrap('magicexp', { methods: ['password', 'magic_link'] });
    const email = `expired-${rand()}@example.com`;
    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email },
    });
    const { magicLinkToken } = requested.json().data as { magicLinkToken: string };
    expect(magicLinkToken).toBeTruthy();

    // Age it past the 15-minute window. The token is stored hashed, so the
    // only way to expire one is to move its expiry.
    await prisma.magicLinkToken.updateMany({
      where: { applicationId: b.applicationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { token: magicLinkToken },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MAGIC_LINK_EXPIRED');
    // The distinguishing behaviour: an expired link is NOT a sign-up path.
    expect(
      await prisma.endUser.findUnique({
        where: { applicationId_email: { applicationId: b.applicationId, email } },
      }),
    ).toBeNull();
    // ...and the token stays unconsumed, so nothing was silently spent.
    const row = await prisma.magicLinkToken.findFirstOrThrow({
      where: { applicationId: b.applicationId },
    });
    expect(row.consumedAt).toBeNull();
  });

  // ---------- MFA_CHALLENGE_INVALID ----------

  it('MFA_CHALLENGE_INVALID: an end-user challenge token that is not a real one', async () => {
    const b = await bootstrap('mfaeu');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa-verify',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { mfaChallengeToken: 'not.a.challenge.token', code: '123456' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MFA_CHALLENGE_INVALID');
  });

  it('MFA_CHALLENGE_INVALID: the operator surface refuses the same way', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/mfa-verify',
      payload: { mfaChallengeToken: 'not.a.challenge.token', code: '123456' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MFA_CHALLENGE_INVALID');
  });

  // ---------- OAUTH_IDENTITY_TAKEN ----------

  it('OAUTH_IDENTITY_TAKEN: a provider account cannot be re-pointed at a second user', async () => {
    const b = await bootstrap('oauthtaken');
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/oauth-config/google`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        clientId: 'gid',
        clientSecret: 'gsec',
        redirectUri: 'https://app.example/oauth/google/callback',
      },
    });

    // The same Google account, whoever asks.
    const sharedGoogleAccountId = `taken-${rand()}`;
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: () => 'https://mock.example/start',
      exchange: async () => ({
        providerAccountId: sharedGoogleAccountId,
        email: `owner-${rand()}@example.com`,
        emailVerified: true,
      }),
    });

    async function signUpUser(): Promise<{ accessToken: string; id: string }> {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: `eu-${rand()}@example.com`, password: 'pw-one-two-three' },
      });
      expect(r.statusCode).toBe(201);
      const data = r.json().data as { accessToken: string; endUser: { id: string } };
      return { accessToken: data.accessToken, id: data.endUser.id };
    }
    function link(accessToken: string): ReturnType<typeof app.inject> {
      return app.inject({
        method: 'POST',
        url: '/api/v1/auth/oauth/google/link/complete',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-rekey-user-token': accessToken,
        },
        payload: { code: 'mock-code' },
      });
    }

    const first = await signUpUser();
    const second = await signUpUser();

    expect((await link(first.accessToken)).statusCode).toBe(200);

    const stolen = await link(second.accessToken);
    expect(stolen.statusCode).toBe(409);
    expect(stolen.json().error.code).toBe('OAUTH_IDENTITY_TAKEN');

    // The identity still belongs to the first user — the refusal is what
    // stops "sign in with Google" becoming an account-takeover primitive.
    const identity = await prisma.oAuthIdentity.findFirstOrThrow({
      where: { provider: 'google', providerAccountId: sharedGoogleAccountId },
    });
    expect(identity.endUserId).toBe(first.id);
    expect(
      await prisma.oAuthIdentity.count({ where: { endUserId: second.id } }),
    ).toBe(0);
  });

  // ---------- COUPON_* ----------

  describe('coupon validation refusals', () => {
    async function couponFixture(prefix: string): Promise<Bootstrapped & { userToken: string }> {
      const b = await bootstrap(prefix);
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${b.applicationId}/billing-config`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: { enabled: true },
      });
      await configureSandboxStripe(b.applicationId);
      const plan = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${b.applicationId}/plans`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { slug: 'pro_monthly', name: 'Pro', amount: 999, currency: 'usd' },
      });
      expect(plan.statusCode).toBe(201);
      const signUp = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: `coupon-${rand()}@example.com`, password: 'pw-one-two-three' },
      });
      return { ...b, userToken: (signUp.json().data as { accessToken: string }).accessToken };
    }

    async function createCoupon(
      f: Bootstrapped,
      body: Record<string, unknown>,
    ): Promise<void> {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${f.applicationId}/coupons`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: body,
      });
      expect(res.statusCode).toBe(201);
    }

    function validate(
      f: Bootstrapped & { userToken: string },
      code: string,
    ): ReturnType<typeof app.inject> {
      return app.inject({
        method: 'POST',
        url: '/api/v1/billing/coupons/validate',
        headers: {
          authorization: `Bearer ${f.liveKey}`,
          'x-rekey-user-token': f.userToken,
        },
        payload: { code, planSlug: 'pro_monthly' },
      });
    }

    it('COUPON_INACTIVE: a deactivated coupon stops discounting', async () => {
      const f = await couponFixture('cinactive');
      await createCoupon(f, { code: 'OFF20', discountType: 'PERCENT', amountOff: 2000 });
      // Active first — otherwise "refused" proves nothing about the flag.
      expect((await validate(f, 'OFF20')).statusCode).toBe(200);

      const off = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/applications/${f.applicationId}/coupons/off20`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { active: false },
      });
      expect(off.statusCode).toBe(200);

      const res = await validate(f, 'OFF20');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('COUPON_INACTIVE');
    });

    it('COUPON_NOT_YET_STARTED: a future startsAt is refused, not applied early', async () => {
      const f = await couponFixture('cfuture');
      await createCoupon(f, {
        code: 'SOON',
        discountType: 'PERCENT',
        amountOff: 1000,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

      const res = await validate(f, 'SOON');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('COUPON_NOT_YET_STARTED');

      // Same coupon, once its window opens.
      await prisma.coupon.updateMany({
        where: { applicationId: f.applicationId, code: 'soon' },
        data: { startsAt: new Date(Date.now() - 1000) },
      });
      const ok = await validate(f, 'SOON');
      expect(ok.statusCode).toBe(200);
      expect((ok.json().data as { discountAmount: number }).discountAmount).toBe(99);
    });

    it('COUPON_CURRENCY_MISMATCH: a fixed-amount coupon is not applied across currencies', async () => {
      const f = await couponFixture('ccurrency');
      // The plan is priced in USD; this coupon is denominated in EUR. Applying
      // it anyway would take 500 *cents* off a dollar price — a silent
      // mispricing, which is exactly why the code exists.
      await createCoupon(f, {
        code: 'EUR5',
        discountType: 'AMOUNT',
        amountOff: 500,
        currency: 'EUR',
      });

      const res = await validate(f, 'EUR5');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('COUPON_CURRENCY_MISMATCH');

      // A coupon with no currency restriction is not caught by the same gate.
      await createCoupon(f, { code: 'ANY5', discountType: 'AMOUNT', amountOff: 500 });
      const ok = await validate(f, 'ANY5');
      expect(ok.statusCode).toBe(200);
      expect((ok.json().data as { discountAmount: number }).discountAmount).toBe(500);
    });
  });

  // ---------- OPERATOR_SCOPE_UNKNOWN ----------

  it('an unrecognised PAT scope fails closed at the HTTP boundary, minting nothing', async () => {
    const b = await bootstrap('patscope');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { name: 'typo', scopes: ['keys:mints'] },
    });
    expect(res.statusCode).toBe(400);
    // NOTE: this is `BAD_REQUEST`, not `OPERATOR_SCOPE_UNKNOWN`. The route's
    // JSON schema pins `scopes.items` to the OPERATOR_TOKEN_SCOPES enum, so
    // Fastify rejects the body before the handler runs and the service-level
    // code is unreachable over HTTP. It is defence in depth for any non-HTTP
    // caller of `operatorTokensService.mint` — covered directly below. Pinned
    // here so nobody "fixes" this to the service code without first removing
    // the schema enum.
    expect(res.json().error.code).toBe('BAD_REQUEST');
    // Fail CLOSED either way: a typo must not silently mint a token.
    expect(await prisma.tenantApiToken.count({ where: { tenantId: b.tenantId } })).toBe(0);
  });

  it('OPERATOR_SCOPE_UNKNOWN: the service rejects an unknown scope rather than dropping it', async () => {
    const b = await bootstrap('patservice');
    const tenantUser = await prisma.tenantUser.findFirstOrThrow({
      where: { memberships: { some: { tenantId: b.tenantId } } },
    });

    // Silently dropping the unknown entry would produce a token with FEWER
    // scopes than asked for — the caller would believe it can mint keys and
    // find out in production. Fail closed instead.
    await expect(
      operatorTokensService.mint({
        tenantUserId: tenantUser.id,
        tenantId: b.tenantId,
        name: 'typo',
        scopes: ['read', 'keys:mints'],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'OPERATOR_SCOPE_UNKNOWN' });
    expect(await prisma.tenantApiToken.count({ where: { tenantId: b.tenantId } })).toBe(0);
  });

  it('an empty scope list is the read-only default, not a refusal', async () => {
    const b = await bootstrap('patdefault');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { name: 'default-scopes' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json().data as { apiToken: { scopes: string[] } }).apiToken.scopes).toEqual([
      'read',
    ]);
  });

  // ---------- PLAN_ENTITLEMENT_NOT_FOUND ----------

  it('PLAN_ENTITLEMENT_NOT_FOUND: deleting an entitlement that is not on this plan', async () => {
    const b = await bootstrap('planent');
    const mkPlan = async (slug: string): Promise<void> => {
      const r = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${b.applicationId}/plans`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: { slug, name: slug, amount: 100 },
      });
      expect(r.statusCode).toBe(201);
    };
    await mkPlan('alpha');
    await mkPlan('beta');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/plans/alpha/entitlements`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { kind: 'FEATURE', key: 'reports', valueType: 'BOOL', value: 'true' },
    });
    expect(put.statusCode).toBe(200);
    const entitlementId = (put.json().data as { id: string }).id;

    // Unknown id.
    const ghost = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/plans/alpha/entitlements/does-not-exist`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error.code).toBe('PLAN_ENTITLEMENT_NOT_FOUND');

    // Real id, wrong plan — the check is `row.planId !== planId`, not just
    // existence, so this is the case that actually exercises the guard.
    const wrongPlan = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/plans/beta/entitlements/${entitlementId}`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(wrongPlan.statusCode).toBe(404);
    expect(wrongPlan.json().error.code).toBe('PLAN_ENTITLEMENT_NOT_FOUND');
    // Still attached to alpha.
    expect(await prisma.planEntitlement.count({ where: { id: entitlementId } })).toBe(1);

    // And the correct plan does delete it.
    const ok = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/plans/alpha/entitlements/${entitlementId}`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(await prisma.planEntitlement.count({ where: { id: entitlementId } })).toBe(0);
  });
});
