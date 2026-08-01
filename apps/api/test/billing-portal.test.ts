/**
 * End-user self-service billing surface (portal v1):
 *
 *   GET  /api/v1/billing/payments            — caller's OWN payment history
 *   POST /api/v1/billing/subscription/cancel — self-service cancellation
 *
 * Both require the Application API key + the end-user JWT. Payments must be
 * strictly scoped to the caller; cancel must honor at-period-end vs immediate
 * semantics (provider calls go through the deterministic stub under test).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('end-user billing portal surface', () => {
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

  beforeEach(async () => {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'PortalT', ownerEmail: 'portal@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'PortalApp', slug: 'portal-app', enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    applicationId = application.id;
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string }).then((d) => d.rawKey);
    await configureSandboxStripe(applicationId);
  });

  async function signUpUser(email: string): Promise<{ accessToken: string; id: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { accessToken: string; endUser: { id: string } };
    return { accessToken: data.accessToken, id: data.endUser.id };
  }

  async function createPlan(slug: string, amount = 999): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { slug, name: slug, amount },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { id: string }).id;
  }

  const userHeaders = (accessToken: string): Record<string, string> => ({
    authorization: `Bearer ${liveKey}`,
    'x-rekey-user-token': accessToken,
  });

  // ---------------------------------------------------------------------
  // GET /billing/payments
  // ---------------------------------------------------------------------

  it('GET /billing/payments requires a user token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/payments',
      headers: { authorization: `Bearer ${liveKey}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('USER_TOKEN_MISSING');
  });

  it('GET /billing/payments returns an empty list for a fresh user', async () => {
    const { accessToken } = await signUpUser('fresh@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/payments',
      headers: userHeaders(accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it("GET /billing/payments returns only the caller's own payments, newest first", async () => {
    const planId = await createPlan('pro');
    const alice = await signUpUser('alice@example.com');
    const bob = await signUpUser('bob@example.com');

    const sub = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: alice.id,
        planId,
        status: 'ACTIVE',
        provider: 'stripe',
      },
    });
    await prisma.payment.create({
      data: {
        applicationId,
        endUserId: alice.id,
        subscriptionId: sub.id,
        amount: 999,
        currency: 'USD',
        status: 'SUCCEEDED',
        description: 'first month',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prisma.payment.create({
      data: {
        applicationId,
        endUserId: alice.id,
        subscriptionId: sub.id,
        amount: 999,
        currency: 'USD',
        status: 'SUCCEEDED',
        description: 'second month',
        createdAt: new Date('2026-02-01T00:00:00Z'),
        metadata: { receiptUrl: 'https://pay.stripe.example/receipts/abc' },
      },
    });
    // Bob's payment must never show up in Alice's list.
    await prisma.payment.create({
      data: {
        applicationId,
        endUserId: bob.id,
        amount: 555,
        currency: 'USD',
        status: 'SUCCEEDED',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/payments',
      headers: userHeaders(alice.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const payments = res.json().data as Array<{
      amount: number;
      description: string | null;
      planSlug: string | null;
      receiptUrl: string | null;
    }>;
    expect(payments).toHaveLength(2);
    // Newest first.
    expect(payments[0]!.description).toBe('second month');
    expect(payments[1]!.description).toBe('first month');
    // Plan slug resolved through the subscription join.
    expect(payments[0]!.planSlug).toBe('pro');
    // Receipt URL surfaced only when present in metadata.
    expect(payments[0]!.receiptUrl).toBe('https://pay.stripe.example/receipts/abc');
    expect(payments[1]!.receiptUrl).toBeNull();
  });

  it('GET /billing/payments rejects non-https receipt URLs and respects ?limit=', async () => {
    const { accessToken, id } = await signUpUser('limits@example.com');
    await prisma.payment.create({
      data: {
        applicationId,
        endUserId: id,
        amount: 1,
        currency: 'USD',
        status: 'SUCCEEDED',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        metadata: { receiptUrl: 'javascript:alert(1)' },
      },
    });
    await prisma.payment.create({
      data: {
        applicationId,
        endUserId: id,
        amount: 2,
        currency: 'USD',
        status: 'FAILED',
        createdAt: new Date('2026-02-01T00:00:00Z'),
      },
    });

    const limited = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/payments?limit=1',
      headers: userHeaders(accessToken),
    });
    expect(limited.statusCode).toBe(200);
    expect(limited.json().data).toHaveLength(1);
    expect((limited.json().data as Array<{ amount: number }>)[0]!.amount).toBe(2);

    const all = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/payments',
      headers: userHeaders(accessToken),
    });
    const rows = all.json().data as Array<{ receiptUrl: string | null }>;
    expect(rows).toHaveLength(2);
    // javascript: scheme never leaves the API.
    expect(rows[1]!.receiptUrl).toBeNull();
  });

  it('GET /billing/payments never exposes providerPaymentId or raw metadata', async () => {
    const { accessToken, id } = await signUpUser('shape@example.com');
    await prisma.payment.create({
      data: {
        applicationId,
        endUserId: id,
        amount: 999,
        currency: 'USD',
        status: 'SUCCEEDED',
        providerPaymentId: 'in_secret_correlation_id',
        metadata: { internal: 'do-not-leak' },
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/payments',
      headers: userHeaders(accessToken),
    });
    const row = (res.json().data as Array<Record<string, unknown>>)[0]!;
    expect(row.providerPaymentId).toBeUndefined();
    expect(row.metadata).toBeUndefined();
    expect(res.body).not.toContain('in_secret_correlation_id');
    expect(res.body).not.toContain('do-not-leak');
  });

  // ---------------------------------------------------------------------
  // POST /billing/subscription/cancel
  // ---------------------------------------------------------------------

  it('cancel returns SUBSCRIPTION_NOT_FOUND when the user has no subscription', async () => {
    const { accessToken } = await signUpUser('nosub@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: userHeaders(accessToken),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SUBSCRIPTION_NOT_FOUND');
  });

  it('cancel marks a PENDING (abandoned-checkout) subscription CANCELED immediately', async () => {
    await createPlan('starter');
    const { accessToken } = await signUpUser('pending@example.com');
    const checkout = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: userHeaders(accessToken),
      payload: {
        planSlug: 'starter',
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
      },
    });
    expect(checkout.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: userHeaders(accessToken),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const sub = res.json().data as { status: string; canceledAt: string | null };
    expect(sub.status).toBe('CANCELED');
    expect(sub.canceledAt).not.toBeNull();

    // The current-subscription read no longer surfaces it.
    const current = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/subscription',
      headers: userHeaders(accessToken),
    });
    expect(current.json().data).toBeNull();
  });

  it('cancel (default) schedules an ACTIVE provider-backed sub at period end and is idempotent', async () => {
    const planId = await createPlan('pro2');
    const { accessToken, id } = await signUpUser('periodend@example.com');
    const periodEnd = new Date('2099-01-01T00:00:00Z');
    await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: id,
        planId,
        status: 'ACTIVE',
        provider: 'stripe',
        providerSubId: 'sub_portal_test_1',
        currentPeriodEnd: periodEnd,
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: userHeaders(accessToken),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const sub = res.json().data as { status: string; cancelAt: string | null; canceledAt: string | null };
    // Stays ACTIVE until the provider webhook terminates it.
    expect(sub.status).toBe('ACTIVE');
    expect(sub.cancelAt).toBe(periodEnd.toISOString());
    expect(sub.canceledAt).toBeNull();

    // Second cancel is a no-op, not an error.
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: userHeaders(accessToken),
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect((again.json().data as { cancelAt: string | null }).cancelAt).toBe(periodEnd.toISOString());
  });

  it('cancel with atPeriodEnd:false terminates immediately', async () => {
    const planId = await createPlan('pro3');
    const { accessToken, id } = await signUpUser('immediate@example.com');
    await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: id,
        planId,
        status: 'ACTIVE',
        provider: 'stripe',
        providerSubId: 'sub_portal_test_2',
        currentPeriodEnd: new Date('2099-01-01T00:00:00Z'),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: userHeaders(accessToken),
      payload: { atPeriodEnd: false },
    });
    expect(res.statusCode).toBe(200);
    const sub = res.json().data as { status: string; canceledAt: string | null };
    expect(sub.status).toBe('CANCELED');
    expect(sub.canceledAt).not.toBeNull();
  });

  it('cancel falls back to a local immediate cancel when the sub has no provider-side record', async () => {
    const planId = await createPlan('pro4');
    const { accessToken, id } = await signUpUser('localonly@example.com');
    await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: id,
        planId,
        status: 'ACTIVE',
        provider: 'stripe',
        // No providerSubId — e.g. activated manually / legacy row.
        currentPeriodEnd: new Date('2099-01-01T00:00:00Z'),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: userHeaders(accessToken),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { status: string }).status).toBe('CANCELED');
  });

  it('cancel requires the billing:write scope', async () => {
    const readOnlyKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'ro', mode: 'live', scopes: ['billing:read'] },
      })
      .then((r) => r.json().data as { rawKey: string });
    const { accessToken } = await signUpUser('scoped@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: {
        authorization: `Bearer ${readOnlyKey.rawKey}`,
        'x-rekey-user-token': accessToken,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});
