/**
 * Plan creation must not require a provider the Application does not use.
 *
 * `plansService.create` eagerly registers new plans against Stripe. While a
 * stub provider existed that call could never fail, so it was unconditional.
 * When the stubs were deleted it became a hard dependency: a PayPal-only or
 * Razorpay-only operator — or anyone who had not configured billing yet —
 * could no longer create a plan, and the error named Stripe, a provider they
 * had deliberately not set up.
 *
 * **Why this file exists separately.** `test/setup.ts` mocks
 * `getProviderForApplication` for the whole suite, so the ordinary
 * "create a plan" assertions in every other file would have passed happily
 * with the bug present — the fake never throws. Each test below is written so
 * the mock cannot absorb the failure:
 *
 *   - the first pins the REAL factory's behaviour via `importActual`, proving
 *     the call that used to be unconditional does throw for these apps;
 *   - the rest assert on the mock's call log, so "we didn't ask for a provider"
 *     is checked directly rather than inferred from the absence of an error.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { getProviderForApplication } from '../src/modules/billing/providers/index.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';

const PASSWORD = 'correct-horse-battery';

describe('plan creation without Stripe credentials', () => {
  let app: FastifyInstance;
  let operator: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    vi.mocked(getProviderForApplication).mockClear();
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: 'plans-op@example.com', password: PASSWORD, workspaceName: 'Plans WS' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
  });

  const createApp = (slug: string): Promise<string> =>
    app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operator}` },
        payload: { name: slug, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);

  const createPlan = (appId: string, slug: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: { authorization: `Bearer ${operator}` },
      payload: { slug, name: slug, amount: 1200, interval: 'MONTH' },
    });

  it('the real provider factory does throw for these apps — the suite mock is what hides it', async () => {
    const appId = await createApp('plans-real-factory');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });

    // Bypass the suite-wide mock deliberately: this asserts what production
    // actually does, and is the reason the assertions below are meaningful.
    const actual = await vi.importActual<
      typeof import('../src/modules/billing/providers/index.js')
    >('../src/modules/billing/providers/index.js');

    await expect(actual.getProviderForApplication(application, 'stripe')).rejects.toMatchObject({
      code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
    });
  });

  it('an application with no billing credentials can still create plans', async () => {
    const appId = await createApp('plans-no-creds');

    const res = await createPlan(appId, 'starter');
    expect(res.statusCode).toBe(201);

    // The point: no provider was requested at all. Without this assertion the
    // test would pass on the broken code too, because the fake would answer.
    expect(vi.mocked(getProviderForApplication)).not.toHaveBeenCalled();

    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId } });
    expect(plan.metadata).not.toHaveProperty('stripe');
  });

  it('a Razorpay-only application can create plans without touching Stripe', async () => {
    const appId = await createApp('plans-rzp-only');
    await billingCredentialsService.upsertCredentials(appId, 'razorpay', {
      keyId: 'rzp_test_ci_only',
      keySecret: 'ci_only',
      webhookSecret: 'ci_only',
    });

    const res = await createPlan(appId, 'pro');
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(getProviderForApplication)).not.toHaveBeenCalled();
  });

  it('an application WITH Stripe credentials still registers eagerly', async () => {
    const appId = await createApp('plans-stripe');
    await billingCredentialsService.upsertCredentials(appId, 'stripe', {
      apiKey: 'sk_test_ci_only',
      webhookSecret: 'whsec_ci_only',
    });

    const res = await createPlan(appId, 'pro');
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(getProviderForApplication)).toHaveBeenCalledWith(
      expect.objectContaining({ id: appId }),
      'stripe',
    );

    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId } });
    expect(plan.metadata).toHaveProperty('stripe');
  });
});
