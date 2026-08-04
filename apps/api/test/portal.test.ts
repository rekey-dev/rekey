/**
 * Hosted customer portal (Portal V2) — API surface.
 *
 * Load-bearing properties:
 *   - Public config endpoint returns the app's PUBLISHABLE key only when the
 *     app has opted in; 404 (existence-hiding) otherwise.
 *   - The end-user self-service billing routes accept PUBLISHABLE key + the
 *     caller's own user token (so a backendless hosted portal works), but still
 *     require the user token (the real authorization).
 *   - Money-moving billing routes still require the user token; only public
 *     read surfaces (plans, providers) accept the publishable key alone.
 *   - The hosted-portal origin is auto-allowed for a portal-enabled app even
 *     when the app set a CORS allowlist that doesn't list it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
// Derived from the deployment's configured portal, NOT hardcoded: this used to
// read 'https://portal.rekey.dev' because that was PUBLIC_PORTAL_URL's default.
// When the default was removed (a Rekey-owned default pointed a self-hoster's
// END USERS at our infrastructure) this test silently began asserting against
// an origin the API no longer knew about, and failed 403 instead of 201.
const PORTAL_ORIGIN = new URL(process.env.PUBLIC_PORTAL_URL ?? 'https://portal.test.invalid')
  .origin;

describe('Portal V2 API', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let publicKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'PT', ownerEmail: 'pt@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'PortalApp', slug: 'portal-v2', enableBilling: true },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    applicationId = application.id;
    publicKey = application.publicKey;
  });

  async function enablePortal(): Promise<void> {
    await prisma.application.update({
      where: { id: applicationId },
      data: { hostedPortalEnabled: true },
    });
  }

  async function signUp(email: string): Promise<string> {
    return (await signUpFull(email)).accessToken;
  }
  async function signUpFull(email: string): Promise<{ accessToken: string; id: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${publicKey}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { accessToken: string; endUser: { id: string } };
    return { accessToken: data.accessToken, id: data.endUser.id };
  }
  const pubAuth = (token: string) => ({
    authorization: `Bearer ${publicKey}`,
    'x-rekey-user-token': token,
  });

  // ---------- public config endpoint ----------

  it('GET /portal/config/:slug → 404 when the app has not opted in', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/portal/config/portal-v2' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PORTAL_NOT_FOUND');
  });

  it('GET /portal/config/:slug → 404 for an unknown slug (existence-hiding)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/portal/config/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PORTAL_NOT_FOUND');
  });

  it('GET /portal/config/:slug → 200 with the publishable key + billingSubject when enabled', async () => {
    await enablePortal();
    const res = await app.inject({ method: 'GET', url: '/api/v1/portal/config/portal-v2' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      slug: 'portal-v2',
      name: 'PortalApp',
      publishableKey: publicKey,
      billingEnabled: true,
      billingSubject: 'user',
    });
    // Never leaks secret material.
    expect(JSON.stringify(res.json())).not.toContain('rp_live_');
  });

  it('config reflects saved branding + custom domain', async () => {
    const { applicationsService } = await import('../src/modules/applications/applications.service.js');
    await applicationsService.updatePortalConfig({
      applicationId,
      enabled: true,
      branding: { displayName: 'Acme Billing', primaryColor: '#4f46e5' },
      portalDomain: 'billing.acme-portal-test.com',
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/portal/config/portal-v2' });
    expect(res.json().data.branding).toMatchObject({ displayName: 'Acme Billing', primaryColor: '#4f46e5' });
    // Domain is stored on the app (config endpoint doesn't expose it, but the row has it).
    const row = await prisma.application.findUnique({ where: { id: applicationId } });
    expect(row?.portalDomain).toBe('billing.acme-portal-test.com');
    expect(row?.portalDomainVerifiedAt).toBeNull(); // unverified until DNS check
  });

  // ---------- self-service billing via publishable key + user token ----------

  it("GET /billing/subscription works with publishable key + the user's own token", async () => {
    const token = await signUp('self@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/subscription',
      headers: { authorization: `Bearer ${publicKey}`, 'x-rekey-user-token': token },
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /billing/payments works with publishable key + user token', async () => {
    const token = await signUp('pay@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/payments',
      headers: { authorization: `Bearer ${publicKey}`, 'x-rekey-user-token': token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      items: [],
      page: { total: 0, limit: expect.any(Number), offset: 0, hasMore: false },
    });
  });

  it('org billing: an OWNER reads + cancels the org subscription via publishable key + token; a non-member is 403', async () => {
    const { applicationsService } = await import('../src/modules/applications/applications.service.js');
    await applicationsService.updateAuthConfig({ applicationId, patch: { organizationsEnabled: true } });
    const owner = await signUpFull(`owner-${Math.random().toString(36).slice(2, 7)}@example.com`);

    // Owner creates a team via the end-user org route — now publishable-key accessible.
    const orgSlug = `team-${Math.random().toString(36).slice(2, 7)}`;
    const orgRes = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/organizations/',
      headers: pubAuth(owner.accessToken),
      payload: { name: 'Acme', slug: orgSlug },
    });
    expect(orgRes.statusCode).toBe(201);
    const orgId = (orgRes.json().data as { organization: { id: string } }).organization.id;

    // listOrganizations works with the publishable key + token, and reports OWNER.
    const list = await app.inject({ method: 'GET', url: '/api/v1/users/me/organizations/', headers: pubAuth(owner.accessToken) });
    expect(list.statusCode).toBe(200);
    expect(
      (list.json().data as { items: Array<{ id: string; role: string }> }).items.find(
        (o) => o.id === orgId,
      )?.role,
    ).toBe('OWNER');

    // An ACTIVE subscription whose beneficiary is the org.
    const plan = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${applicationId}/plans`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { slug: 'team', name: 'Team', amount: 4900 },
      })
      .then((r) => (r.json().data as { id: string }).id);
    await prisma.subscription.create({
      data: { applicationId, endUserId: owner.id, planId: plan, beneficiaryOrgId: orgId, status: 'ACTIVE' },
    });

    // Owner reads the org's subscription.
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/billing/subscription?organizationId=${orgId}`,
      headers: pubAuth(owner.accessToken),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.beneficiaryOrgId).toBe(orgId);

    // A non-member cannot read or cancel that org's subscription.
    const stranger = await signUp(`stranger-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const strangerRead = await app.inject({
      method: 'GET',
      url: `/api/v1/billing/subscription?organizationId=${orgId}`,
      headers: pubAuth(stranger),
    });
    expect(strangerRead.statusCode).toBe(403);
    const strangerCancel = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: pubAuth(stranger),
      payload: { organizationId: orgId },
    });
    expect(strangerCancel.statusCode).toBe(403);

    // The owner can cancel the org subscription.
    const ownerCancel = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: pubAuth(owner.accessToken),
      payload: { organizationId: orgId, atPeriodEnd: false },
    });
    expect(ownerCancel.statusCode).toBe(200);
    expect(ownerCancel.json().data.status).toBe('CANCELED');
  });

  it('self-service still REQUIRES the user token (publishable key alone is not enough)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/subscription',
      headers: { authorization: `Bearer ${publicKey}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('USER_TOKEN_MISSING');
  });

  it('public /providers accepts the publishable key (picker can be fetched from the portal)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/providers',
      headers: { authorization: `Bearer ${publicKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data.providers)).toBe(true);
  });

  it('public /providers via the publishable key lists the app\'s enabled providers', async () => {
    const { billingCredentialsService } = await import(
      '../src/modules/billing/credentials.service.js'
    );
    await billingCredentialsService.upsertCredentials(
      applicationId,
      'stripe',
      // DEVELOPMENT app (the default) — only test-mode credentials are allowed.
      { apiKey: 'sk_test_for_ci_only', webhookSecret: 'whsec_x' },
      { enabled: true, mode: 'test' },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/providers',
      headers: { authorization: `Bearer ${publicKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data.providers as Array<{ provider: string }>).map((p) => p.provider)).toEqual([
      'stripe',
    ]);
  });

  // ---------- CORS auto-allow of the portal origin ----------

  describe('with a CORS allowlist that does NOT list the portal origin', () => {
    beforeEach(async () => {
      await prisma.application.update({
        where: { id: applicationId },
        data: { corsOrigins: ['https://app.example.com'], hostedPortalEnabled: true },
      });
    });

    it('publishable request from the portal origin is auto-allowed', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${publicKey}`, origin: PORTAL_ORIGIN },
        payload: { email: 'fromportal@example.com', password: 'pw-one-two-three' },
      });
      expect(res.statusCode).toBe(201);
    });

    it('publishable request from an unlisted, non-portal origin is still blocked', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${publicKey}`, origin: 'https://evil.example.com' },
        payload: { email: 'fromevil@example.com', password: 'pw-one-two-three' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    });

    it('when portal is DISABLED the portal origin is not auto-allowed', async () => {
      await prisma.application.update({
        where: { id: applicationId },
        data: { hostedPortalEnabled: false },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${publicKey}`, origin: PORTAL_ORIGIN },
        payload: { email: 'noportal@example.com', password: 'pw-one-two-three' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    });
  });
});
