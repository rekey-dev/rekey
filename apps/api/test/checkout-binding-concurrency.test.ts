/**
 * Concurrent checkouts must not reach two processors (#437).
 *
 * Every other test of the provider binding is SEQUENTIAL — one checkout, then
 * the next — and all of them pass against code that bills a buyer twice. The
 * guards in #430/#440 are correct and are not the problem: each concurrent
 * request independently reads a state in which nothing binds this buyer, and
 * each is right about what it saw. Nothing serialises read-decide-write.
 *
 * These tests fire overlapping requests and assert on the ROWS, not on the
 * responses. A 200 is not the defect; two subscriptions on two processors is.
 *
 * ## Why these can reproduce it at all
 *
 * The suite's fake provider returns immediately, which makes the window far
 * narrower than production, where a real Stripe call sits between the decision
 * and the write. Narrower, not closed: `createCheckoutSession` awaits the
 * provider between reading the binding and upserting the row, and every await
 * is a yield. If a future change makes these flaky rather than failing, that
 * is the window moving, not the bug going away — widen it with a delay in the
 * fake rather than deleting the test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { configureSandboxPaypal, configureSandboxStripe } from './fakes/billing-credentials.js';

describe('concurrent checkouts and the provider binding (#437)', () => {
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

  async function post<T>(url: string, payload: unknown): Promise<T> {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${process.env.SUPER_ADMIN_KEY ?? 'test-super-admin-key'}` },
      payload: payload as Record<string, unknown>,
    });
    return res.json().data as T;
  }

  beforeEach(async () => {
    const tenant = await post<{ id: string }>('/api/v1/admin/tenants', {
      name: 'RaceT',
      ownerEmail: 'race@example.com',
    });
    const application = await post<{ id: string }>('/api/v1/admin/applications', {
      tenantId: tenant.id,
      name: 'RaceApp',
      slug: `race-app-${Date.now()}`,
      enableBilling: true,
    });
    applicationId = application.id;
    const key = await post<{ rawKey: string }>(
      `/api/v1/admin/applications/${applicationId}/api-keys`,
      { name: 'k', mode: 'live' },
    );
    liveKey = key.rawKey;
    // BOTH processors enabled. That is the situation the bug needs: with one
    // configured, two racing checkouts can only land on the same one and the
    // test would pass against broken code.
    await configureSandboxStripe(applicationId);
    await configureSandboxPaypal(applicationId);
  });

  async function twoPlans(): Promise<{ basic: string; pro: string }> {
    const basic = await post<{ slug: string }>(
      `/api/v1/admin/applications/${applicationId}/plans`,
      { slug: 'basic', name: 'Basic', amount: 900 },
    );
    const pro = await post<{ slug: string }>(`/api/v1/admin/applications/${applicationId}/plans`, {
      slug: 'pro',
      name: 'Pro',
      amount: 2900,
    });
    return { basic: basic.slug, pro: pro.slug };
  }

  async function signUp(): Promise<{ token: string; id: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: {
        email: `race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        password: 'Race-Passw0rd!42',
      },
    });
    const data = res.json().data as { accessToken: string; endUser: { id: string } };
    return { token: data.accessToken, id: data.endUser.id };
  }

  function checkout(
    token: string,
    planSlug: string,
    provider?: string,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': token },
      payload: {
        planSlug,
        successUrl: 'https://example.com/ok',
        cancelUrl: 'https://example.com/no',
        ...(provider !== undefined && { provider }),
      },
    });
  }

  /** Every subscription this buyer holds, with the processor behind each. */
  async function subscriptionsOf(endUserId: string) {
    return prisma.subscription.findMany({
      where: { applicationId, endUserId },
      select: { id: true, provider: true, planId: true, status: true },
    });
  }

  it('two simultaneous checkouts naming DIFFERENT processors bind only one', async () => {
    const { basic } = await twoPlans();
    const user = await signUp();

    // The double-click. Both are in flight before either has written anything.
    const [a, b] = await Promise.all([
      checkout(user.token, basic, 'stripe'),
      checkout(user.token, basic, 'paypal'),
    ]);

    const rows = await subscriptionsOf(user.id);
    const processors = new Set(rows.map((r) => r.provider));

    // The assertion that matters, and it is about ROWS. One of the two
    // requests may legitimately be refused (409) or may legitimately succeed —
    // what must never happen is the buyer ending up billable by two
    // processors at once.
    expect(
      processors.size,
      `buyer is bound to ${processors.size} processors: ${[...processors].join(', ')} ` +
        `(responses ${a.statusCode}/${b.statusCode})`,
    ).toBeLessThanOrEqual(1);
  });

  it('two simultaneous checkouts on DIFFERENT plans do not split across processors', async () => {
    // The plan-keyed uniqueness constraint cannot catch this one: different
    // planId means no collision, so a constraint alone leaves it open. This is
    // the case that makes the fix a lock rather than an index.
    const { basic, pro } = await twoPlans();
    const user = await signUp();

    const [a, b] = await Promise.all([
      checkout(user.token, basic, 'stripe'),
      checkout(user.token, pro, 'paypal'),
    ]);

    const rows = await subscriptionsOf(user.id);
    const processors = new Set(rows.map((r) => r.provider).filter(Boolean));
    expect(
      processors.size,
      `two plans split across ${[...processors].join(', ')} (responses ${a.statusCode}/${b.statusCode})`,
    ).toBeLessThanOrEqual(1);
  });

  it('ten concurrent checkouts leave at most one processor bound', async () => {
    // The measured case from the #430 review: ten concurrent produced seven
    // rows across both processors.
    const { basic, pro } = await twoPlans();
    const user = await signUp();

    const attempts = Array.from({ length: 10 }, (_, i) =>
      checkout(user.token, i % 2 === 0 ? basic : pro, i % 2 === 0 ? 'stripe' : 'paypal'),
    );
    const results = await Promise.all(attempts);

    const rows = await subscriptionsOf(user.id);
    const processors = new Set(rows.map((r) => r.provider).filter(Boolean));
    const ok = results.filter((r) => r.statusCode === 200).length;

    expect(
      processors.size,
      `${rows.length} rows across ${[...processors].join(', ')} from ${ok} successful checkouts`,
    ).toBeLessThanOrEqual(1);
  });
});
