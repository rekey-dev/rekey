/**
 * `trialDays` is HELD, and the refusal is the contract.
 *
 * #474 made the field writable, having found it validated by the route and
 * silently dropped by the service, so every buyer of a plan advertised with a
 * trial was charged on day one. That fix was right and is kept.
 *
 * What it exposed is that the rest of the feature is not safe to sell yet. Two
 * independent release reviews found two ways it loses money:
 *
 *   * `entitlementsService.provision` has no trial gate and checkout calls it
 *     on `checkout.session.completed`, so a SUBSCRIPTION plan carrying
 *     `trialDays` AND a CREDIT or LICENSE entitlement hands those over on day 0,
 *     before any money moves. `provision` has no inverse.
 *   * nothing records that a buyer has already trialled, and the subscription
 *     key reuses a cancelled row, so the same trial can be taken without limit.
 *     `docs/specs/trial-eligibility.md` is the design for that and is not built.
 *
 * So a non-zero `trialDays` is refused at the service, which is the one
 * chokepoint REST, MCP and any future caller share. NOT reverted to the
 * pre-#474 behaviour: accepting the field, answering 201 and dropping it is the
 * defect #474 existed to fix, and would be worse than either honest state.
 *
 * These tests assert the hold, and that the bounds check still runs BEFORE it,
 * so an out-of-range value is still named as out of range rather than as held.
 * When trials return, this file is the list of what has to start working.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { resolveCheckoutTrial } from '../src/modules/billing/checkout-trial.js';
import { plansService } from '../src/modules/plans/plans.service.js';

const PASSWORD = 'correct-horse-battery';

describe('plan trialDays reaches the database and the checkout', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  /** A workspace, an operator token, and one billing-enabled Application. */
  async function setup(slug: string): Promise<{ token: string; appId: string }> {
    const token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `trial-${slug}@example.com`,
          password: PASSWORD,
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    const appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: `App ${slug}`, slug: `trial-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);

    return { token, appId };
  }

  function createPlan(
    token: string,
    appId: string,
    payload: Record<string, unknown>,
  ): ReturnType<FastifyInstance['inject']> {
    return app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it('refuses a trial on create, naming the hold rather than a validation error', async () => {
    const { token, appId } = await setup('held-create');
    const res = await createPlan(token, appId, {
      slug: 'pro',
      name: 'Pro',
      amount: 1000,
      kind: 'SUBSCRIPTION',
      trialDays: 14,
    });
    expect(res.statusCode).toBe(400);
    const err = res.json().error as { code: string; fix: string };
    expect(err.code).toBe('PLAN_TRIAL_UNAVAILABLE');
    // The refusal has to say why, or an operator reads it as a bug in their request.
    expect(err.fix).toMatch(/eligibility/i);

    // And nothing was written. A refusal that half-creates is worse than either.
    const stored = await prisma.plan.findFirst({ where: { applicationId: appId, slug: 'pro' } });
    expect(stored).toBeNull();
  });

  it('refuses a trial through the SERVICE, which is what MCP reaches', async () => {
    // The MCP dispatcher does not validate arguments against a tool's
    // inputSchema, so a guard living only in route zod is not a guard.
    const { appId } = await setup('held-service');
    await expect(
      plansService.create({
        applicationId: appId,
        slug: 'svc',
        name: 'Svc',
        amount: 1000,
        kind: 'SUBSCRIPTION',
        trialDays: 7,
      }),
    ).rejects.toMatchObject({ code: 'PLAN_TRIAL_UNAVAILABLE' });
  });

  it('refuses a trial added to an existing plan', async () => {
    const { token, appId } = await setup('held-update');
    expect(
      (await createPlan(token, appId, { slug: 'basic', name: 'Basic', amount: 500 })).statusCode,
    ).toBe(201);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/plans/basic`,
      headers: { authorization: `Bearer ${token}` },
      payload: { trialDays: 30 },
    });
    expect(patched.statusCode).toBe(400);
    expect((patched.json().error as { code: string }).code).toBe('PLAN_TRIAL_UNAVAILABLE');
  });

  it('names an out-of-range value as out of range, not as held', () => {
    // Through the SERVICE, deliberately. The create route's zod is `min(1)`, so
    // over the wire these are VALIDATION_ERROR and never reach this code. The
    // MCP dispatcher does not validate against a tool's inputSchema, so the
    // service is where an out-of-range value actually arrives — and bounds run
    // BEFORE the hold, or a typo of 400 and a deliberate 14 would give the same
    // answer and the typo would read as a policy decision.
    for (const bad of [400, -1, 14.5]) {
      expect(() =>
        plansService.create({
          applicationId: 'irrelevant',
          slug: 'b',
          name: 'B',
          amount: 100,
          kind: 'SUBSCRIPTION',
          trialDays: bad,
        }),
      ).rejects.toMatchObject({ code: 'PLAN_TRIAL_INVALID' });
    }
  });

  it('still accepts a plan with no trial, and clearing one with 0', async () => {
    const { token, appId } = await setup('held-none');
    expect(
      (await createPlan(token, appId, { slug: 'none', name: 'None', amount: 100 })).statusCode,
    ).toBe(201);

    // 0 is legal on UPDATE (its zod is `min(0)`; create's is `min(1)`), and must
    // stay legal: it is how an operator clears a trial, which the hold must not
    // take away from anyone who already has one.
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/plans/none`,
      headers: { authorization: `Bearer ${token}` },
      payload: { trialDays: 0 },
    });
    expect(cleared.statusCode).toBe(200);

    const row = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'none' } });
    // One encoding of "no trial", so `?? 0` and `> 0` cannot disagree.
    expect(row.trialDays).toBeNull();
  });

  it('offers no trial at checkout for any plan that can now exist', async () => {
    // The read side is untouched and still correct; with the write side held,
    // every real row resolves to no trial.
    const { token, appId } = await setup('held-checkout');
    await createPlan(token, appId, { slug: 'sub', name: 'Sub', amount: 1000 });
    const row = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'sub' } });
    expect(resolveCheckoutTrial({ plan: row, provider: 'stripe', isOneTime: false })).toBeNull();
  });
});
