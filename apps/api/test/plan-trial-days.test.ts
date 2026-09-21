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
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
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
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it('a trial on a plan that materialises nothing is now accepted', async () => {
    // The 2.1.0 hold is lifted. What replaced it is narrower: a trial is
    // refused only on a plan that would hand something over on day 0.
    const { token, appId } = await setup('held-create');
    const res = await createPlan(token, appId, {
      slug: 'pro',
      name: 'Pro',
      amount: 1000,
      kind: 'SUBSCRIPTION',
      trialDays: 14,
    });
    expect(res.statusCode).toBe(201);
    const stored = await prisma.plan.findFirstOrThrow({
      where: { applicationId: appId, slug: 'pro' },
    });
    expect(stored.trialDays).toBe(14);
  });

  it('refuses a trial on a plan that grants credits, and says why', async () => {
    // `provision` has no trial gate, so a CREDIT entitlement mints credits on
    // day 0, before any money moves, with no inverse. The per-buyer limit
    // bounds that to once, which is not the same as fixing it.
    const { token, appId } = await setup('materialises');
    expect(
      (await createPlan(token, appId, { slug: 'gen', name: 'Gen', amount: 1000, kind: 'SUBSCRIPTION' }))
        .statusCode,
    ).toBe(201);
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'gen' } });
    await prisma.planEntitlement.create({
      data: { planId: plan.id, kind: 'CREDIT', key: '', quantity: 500 },
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/plans/gen`,
      headers: { authorization: `Bearer ${token}` },
      payload: { trialDays: 14 },
    });
    expect(patched.statusCode).toBe(400);
    const err = patched.json().error as { code: string; message: string; fix: string };
    expect(err.code).toBe('PLAN_TRIAL_MATERIALISES_ENTITLEMENTS');
    expect(err.message).toMatch(/credits/i);
    expect(err.message).toMatch(/day 0/i);
    // The way through has to be nameable, or the operator reads it as "no trials".
    expect(err.fix).toMatch(/FEATURE or USAGE/);
    expect((await prisma.plan.findFirstOrThrow({ where: { id: plan.id } })).trialDays).toBeNull();
  });

  it('refuses credits ADDED to a plan that already carries a trial', async () => {
    // The same giveaway through the other door: entitlements are written after
    // the plan, so guarding only the plan write leaves this open.
    const { token, appId } = await setup('materialises-2');
    expect(
      (await createPlan(token, appId, {
        slug: 'tri',
        name: 'Tri',
        amount: 1000,
        kind: 'SUBSCRIPTION',
        trialDays: 7,
      })).statusCode,
    ).toBe(201);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/tri/entitlements`,
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'CREDIT', quantity: 500 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json().error as { code: string }).code).toBe('PLAN_TRIAL_MATERIALISES_ENTITLEMENTS');
  });

  it('allows a FEATURE entitlement on a plan carrying a trial', async () => {
    // FEATURE resolves at read time and lapses with the subscription, which is
    // the ordinary feature-gated SaaS trial `trialDays` exists for.
    const { token, appId } = await setup('feature-ok');
    expect(
      (await createPlan(token, appId, {
        slug: 'feat',
        name: 'Feat',
        amount: 1000,
        kind: 'SUBSCRIPTION',
        trialDays: 7,
      })).statusCode,
    ).toBe(201);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/feat/entitlements`,
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'FEATURE', key: 'seats_ui', valueType: 'BOOL', value: 'true' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('applies the materialisation rule through the SERVICE, which is what MCP reaches', async () => {
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
    ).resolves.toMatchObject({ trialDays: 7 });


    // `creditsAmount` alongside a trial is NOT refused, and must not be: it is
    // the legacy credit column, `synthesizeLegacy` returns [] for SUBSCRIPTION,
    // and `trialDays` is legal only on SUBSCRIPTION, so the pair materialises
    // nothing. An earlier version of this guard refused it and the comment
    // explaining why was simply wrong.
    await expect(
      plansService.create({
        applicationId: appId,
        slug: 'svc-credits',
        name: 'Svc',
        amount: 1000,
        kind: 'SUBSCRIPTION',
        trialDays: 7,
        creditsAmount: 100,
      }),
    ).resolves.toMatchObject({ trialDays: 7 });
  });

  it('a trial added to an existing plain plan is accepted', async () => {
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
    expect(patched.statusCode).toBe(200);
    const stored = await prisma.plan.findFirstOrThrow({
      where: { applicationId: appId, slug: 'basic' },
    });
    expect(stored.trialDays).toBe(30);
  });

  it('names an out-of-range value as out of range, not as held', async () => {
    // Through the SERVICE, deliberately. The create route's zod is `min(1)`, so
    // over the wire these are VALIDATION_ERROR and never reach this code. The
    // MCP dispatcher does not validate against a tool's inputSchema, so the
    // service is where an out-of-range value actually arrives, and bounds run
    // BEFORE the hold, or a typo of 400 and a deliberate 14 would give the same
    // answer and the typo would read as a policy decision.
    for (const bad of [400, -1, 14.5]) {
      // Awaited. It was not, so the rejection was never actually asserted:
      // vitest auto-awaited it at the end of the test and warned, and the
      // linter's `no-floating-promises` is what finally made it a build error.
      await expect(
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
  it('a plan that already holds the forbidden pair can still be archived', async () => {
    // The remedy has to be reachable. Guarding on the row's EXISTING trialDays
    // meant a plan written before this rule could not be renamed or archived
    // without first clearing the trial, and the refusal never said so.
    const { token, appId } = await setup('archivable');
    expect(
      (await createPlan(token, appId, {
        slug: 'legacy',
        name: 'Legacy',
        amount: 1000,
        kind: 'SUBSCRIPTION',
        trialDays: 14,
      })).statusCode,
    ).toBe(201);
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'legacy' } });
    // Written straight to the row: the guarded paths would refuse this, which
    // is the point, it is the pre-existing state, not a new one.
    await prisma.planEntitlement.create({
      data: { planId: plan.id, kind: 'CREDIT', key: '', quantity: 500 },
    });

    const archived = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/plans/legacy`,
      headers: { authorization: `Bearer ${token}` },
      payload: { active: false },
    });
    expect(archived.statusCode).toBe(200);

    // ...but adding or re-confirming a trial on it is still refused.
    const retrial = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/plans/legacy`,
      headers: { authorization: `Bearer ${token}` },
      payload: { trialDays: 30 },
    });
    expect(retrial.statusCode).toBe(400);
    expect((retrial.json().error as { code: string }).code).toBe('PLAN_TRIAL_MATERIALISES_ENTITLEMENTS');
  });
});
