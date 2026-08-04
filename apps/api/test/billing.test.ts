/**
 * Billing scaffold — admin plan CRUD + public plan list + checkout flow +
 * subscription resolution.
 *
 * No Stripe account is dialled. `test/setup.ts` mocks
 * `getProviderForApplication` with the deterministic fakes in
 * `test/fakes/billing-providers.ts` (same input always produces the same
 * provider id and URL), which is enough to exercise the full wiring. The
 * shipped `src/modules/billing/providers/` factory has no stub to fall back
 * on — it refuses with `BILLING_CREDENTIALS_NOT_CONFIGURED`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('billing scaffold', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(): Promise<{
    applicationId: string;
    liveKey: string;
  }> {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'BillT', ownerEmail: 'bill@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'BillApp', slug: 'bill-app', enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    await configureSandboxStripe(application.id);
    return { applicationId: application.id, liveKey: key.rawKey };
  }

  async function createPlan(
    appId: string,
    body: { slug: string; name: string; amount: number; interval?: 'MONTH' | 'YEAR' },
  ): Promise<Record<string, unknown>> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${appId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return res.json().data as Record<string, unknown>;
  }

  beforeEach(async () => {
    ({ applicationId, liveKey } = await bootstrap());
  });

  // ---------- admin plans CRUD ----------

  it('creates a plan and registers it with the provider stub', async () => {
    const plan = await createPlan(applicationId, {
      slug: 'pro_monthly',
      name: 'Pro',
      amount: 999,
    });
    expect(plan.slug).toBe('pro_monthly');
    expect(plan.amount).toBe(999);
    expect(plan.currency).toBe('USD');
    expect(plan.interval).toBe('MONTH');
    expect(plan.active).toBe(true);
    // Provider registration roundtrips back into metadata.
    expect((plan.metadata as { stripe?: { priceId?: string } }).stripe?.priceId).toMatch(
      /^price_[a-f0-9]{24}$/,
    );
  });

  it('rejects invalid slug + amount + duplicate', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { slug: 'NOT VALID', name: 'X', amount: 0 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('PLAN_SLUG_INVALID');

    await createPlan(applicationId, { slug: 'dup', name: 'D', amount: 100 });
    const dup = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { slug: 'dup', name: 'D2', amount: 100 },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('PLAN_SLUG_TAKEN');
  });

  it('lists active plans only by default; includes inactive when asked', async () => {
    await createPlan(applicationId, { slug: 'a', name: 'A', amount: 100 });
    await createPlan(applicationId, { slug: 'b', name: 'B', amount: 200 });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/applications/${applicationId}/plans/b`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { active: false },
    });

    const activeOnly = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    const activePage = activeOnly.json().data as { items: unknown[]; page: { total: number } };
    expect(activePage.items).toHaveLength(1);
    // `total` counts behind the same filter, so it moves with `includeInactive`
    // rather than reporting the whole table.
    expect(activePage.page.total).toBe(1);

    const all = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/applications/${applicationId}/plans?includeInactive=true`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    const allPage = all.json().data as { items: unknown[]; page: { total: number } };
    expect(allPage.items).toHaveLength(2);
    expect(allPage.page.total).toBe(2);
  });

  // ---------- public /billing/plans ----------

  it('public GET /billing/plans returns active plans for the calling Application', async () => {
    await createPlan(applicationId, { slug: 'lite', name: 'Lite', amount: 500 });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/plans',
      headers: { authorization: `Bearer ${liveKey}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { items: Array<{ slug: string }> };
    expect(data.items.map((p) => p.slug)).toContain('lite');
  });

  it('GET /billing/plans rejects without an API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/billing/plans' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('API_KEY_MISSING');
  });

  it('gates the public billing surface with 403 when billing is disabled', async () => {
    // App created WITHOUT enableBilling → billing surface is off.
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'NoBillT', ownerEmail: 'nobill@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    const offApp = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'NoBillApp', slug: 'no-bill-app' },
      })
      .then((r) => r.json().data as { id: string });
    const offKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${offApp.id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/plans',
      headers: { authorization: `Bearer ${offKey.rawKey}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('BILLING_DISABLED');
  });

  // ---------- subscription + checkout ----------

  async function signUpUser(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: 'sub@example.com', password: 'pw-one-two-three' },
    });
    return (res.json().data as { accessToken: string }).accessToken;
  }

  it('GET /billing/subscription returns null when the user has no subscription', async () => {
    const accessToken = await signUpUser();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/subscription',
      headers: {
        authorization: `Bearer ${liveKey}`,
        'x-rekey-user-token': accessToken,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeNull();
  });

  it('POST /billing/checkout creates a PENDING subscription and returns a provider URL', async () => {
    await createPlan(applicationId, { slug: 'pro_monthly', name: 'Pro', amount: 999 });
    const accessToken = await signUpUser();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: {
        authorization: `Bearer ${liveKey}`,
        'x-rekey-user-token': accessToken,
      },
      payload: {
        planSlug: 'pro_monthly',
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
      },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      url: string;
      subscription: { status: string; metadata: { checkoutSessionId?: string } };
    };
    expect(data.url).toMatch(/^https:\/\/checkout\.stripe\.example\/cs_/);
    expect(data.subscription.status).toBe('PENDING');
    expect(data.subscription.metadata.checkoutSessionId).toMatch(/^cs_[a-f0-9]{24}$/);
  });

  it('checkout against a missing plan returns PLAN_NOT_FOUND', async () => {
    const accessToken = await signUpUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: {
        authorization: `Bearer ${liveKey}`,
        'x-rekey-user-token': accessToken,
      },
      payload: {
        planSlug: 'ghost_plan',
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PLAN_NOT_FOUND');
  });

  it('checkout against an inactive plan returns PLAN_INACTIVE', async () => {
    await createPlan(applicationId, { slug: 'old', name: 'Old', amount: 100 });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/applications/${applicationId}/plans/old`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { active: false },
    });
    const accessToken = await signUpUser();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: {
        authorization: `Bearer ${liveKey}`,
        'x-rekey-user-token': accessToken,
      },
      payload: {
        planSlug: 'old',
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PLAN_INACTIVE');
  });

  it('repeated checkout for the same plan reuses the PENDING row (no parallel pendings)', async () => {
    await createPlan(applicationId, { slug: 'pro_monthly', name: 'Pro', amount: 999 });
    const accessToken = await signUpUser();

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: {
        authorization: `Bearer ${liveKey}`,
        'x-rekey-user-token': accessToken,
      },
      payload: {
        planSlug: 'pro_monthly',
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
      },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: {
        authorization: `Bearer ${liveKey}`,
        'x-rekey-user-token': accessToken,
      },
      payload: {
        planSlug: 'pro_monthly',
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
      },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const idA = (first.json().data as { subscription: { id: string } }).subscription.id;
    const idB = (second.json().data as { subscription: { id: string } }).subscription.id;
    expect(idA).toBe(idB); // upsert reused the row
  });
});
