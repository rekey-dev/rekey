/**
 * `TENANT_SUBSCRIPTION_GRANTS=disabled` closes the operator grant surface.
 *
 * This switch is the reason granting can be opened to OWNER/ADMIN at all.
 * `billing-admin.routes.ts` held it at the super-admin key because on a
 * deployment that SELLS to the workspaces it hosts, a granted subscription can
 * write the granter's own allowance, and said that tenant scoping contains
 * that only incidentally, which is why it stayed shut. The switch is how such a
 * deployment says so deliberately instead of relying on the accident.
 *
 * A safety valve nobody tests is a safety valve nobody has. It lives in its own
 * file because `env` is parsed once at import, so flipping it means mocking the
 * config module for the whole module graph.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();
  return { ...actual, env: { ...actual.env, TENANT_SUBSCRIPTION_GRANTS: 'disabled' } };
});

const { buildApp } = await import('../src/app.js');

describe('operator subscription grants, switched off', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Built per test, not once in `beforeAll`: `test/setup.ts` truncates every
   * domain table in `beforeEach`, so a fixture created before the suite is gone
   * by the time the first case runs and its access token authenticates as an
   * operator who no longer exists, a 401 that looks nothing like the thing
   * under test.
   */
  async function world(): Promise<{
    ownerToken: string;
    applicationId: string;
    endUserId: string;
  }> {
    const tag = `offgrant-${Math.random().toString(36).slice(2, 7)}`;
    const su = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `owner-${tag}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: 'Off Co',
      },
    });
    expect(su.statusCode).toBe(201);
    const ownerToken = (su.json().data as { accessToken: string }).accessToken;

    const appRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Off app', slug: tag },
    });
    expect(appRes.statusCode).toBe(201);
    const applicationId = (appRes.json().data as { id: string }).id;

    const plan = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        slug: `${tag}-pro`,
        name: 'Pro',
        amount: 2900,
        kind: 'SUBSCRIPTION',
        interval: 'MONTH',
      },
    });
    expect(plan.statusCode).toBe(201);

    const eu = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/end-users`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { email: `buyer-${tag}@example.com` },
    });
    expect(eu.statusCode).toBe(201);
    return { ownerToken, applicationId, endUserId: (eu.json().data as { id: string }).id };
  }

  it('the grant route is absent, even for the OWNER', async () => {
    const { ownerToken, applicationId, endUserId } = await world();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/end-users/${endUserId}/subscriptions`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { planSlug: `${applicationId}-nope` },
    });
    // 404 rather than 403: the same non-disclosure posture as the rest of the
    // tenant surface. The CODE still says why, because "this deployment does
    // not offer this" is not a secret and an operator hunting a missing button
    // deserves to find out.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TENANT_SUBSCRIPTION_GRANTS_DISABLED');
    expect(res.json().error.fix).toContain('TENANT_SUBSCRIPTION_GRANTS');
  });

  it('the cancel route stays available — the switch is about granting only', async () => {
    // Deliberately NOT gated. The switch exists because granting CREATES
    // entitlement on an assertion; cancelling removes it and fails safe. Gating
    // it here would also have been incoherent: the operator MCP
    // `cancel_subscription` tool ignores this flag, so a `disabled` deployment
    // would be back to an agent being able to cancel while the panel could not,
    // which is the asymmetry these routes exist to remove.
    const { ownerToken, applicationId, endUserId } = await world();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/end-users/${endUserId}/subscriptions/sub_whatever/cancel`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {},
    });
    // Reached the handler and got as far as looking the subscription up, rather
    // than being refused at the door.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SUBSCRIPTION_NOT_FOUND');
  });

  it('the refusal happens before anything is written', async () => {
    const { ownerToken, applicationId, endUserId } = await world();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/end-users/${endUserId}/subscriptions`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { planSlug: `${applicationId}-pro` },
    });
    expect(res.statusCode).toBe(404);

    const { prisma } = await import('../src/lib/prisma.js');
    expect(await prisma.subscription.count({ where: { applicationId } })).toBe(0);
    expect(
      await prisma.securityEvent.count({
        where: { applicationId, type: 'app.subscription_granted' },
      }),
    ).toBe(0);
  });

  it('the super-admin route still works, so granting is moved rather than removed', async () => {
    const { applicationId, endUserId, ownerToken } = await world();
    const tag = applicationId.slice(-6);
    const plan = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        slug: `sa-${tag}`,
        name: 'SA',
        amount: 1000,
        kind: 'SUBSCRIPTION',
        interval: 'MONTH',
      },
    });
    expect(plan.statusCode).toBe(201);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/subscriptions`,
      headers: { authorization: `Bearer ${process.env.SUPER_ADMIN_KEY}` },
      payload: { planSlug: `sa-${tag}`, endUserId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.activated).toBe(true);
  });
});
