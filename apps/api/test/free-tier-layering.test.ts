/**
 * The free tier is a BASE LAYER under what a subscription says, not another
 * voter in the merge beside it.
 *
 * `resolveForEndUser` unions across sources (booleans OR-true, numbers take the
 * max) and `includedQuotaFor` ADDS, both of which are right for two
 * subscriptions a subject genuinely holds and wrong for a default they have not
 * bought. Making the fallback conditional is easy to get subtly wrong in two
 * directions, and these are those two directions:
 *
 *   * suppress on "a row MENTIONED this meter" and a row that caps nothing
 *     turns a capped subject UNCAPPED, which is #484's failure through another
 *     door;
 *   * suppress on "a key APPEARED" and a key whose value cannot be parsed
 *     withholds the default and vanishes from `features` entirely, which is
 *     worse than either value.
 *
 * Both are reachable through supported calls, with no hand-written rows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';

describe('the free tier is a base layer', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `lk-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'LK', slug: `lk-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/usage-meters`,
      headers: auth(),
      payload: { slug: 'calls', name: 'calls', unit: 'calls' },
    });
  });

  const makeEndUser = async (): Promise<string> =>
    app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: auth(),
        payload: { email: `eu-${Math.random().toString(36).slice(2, 8)}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => (r.json().data as { id: string }).id);

  /** A plan of any kind, with an optional USAGE allowance on `calls`. */
  async function makePlan(kind: string, included?: number): Promise<string> {
    const slug = `${kind.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`;
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: {
        slug,
        name: slug,
        amount: kind === 'SUBSCRIPTION' ? 0 : 500,
        kind,
        ...(kind === 'CREDIT' && { creditsAmount: 100 }),
        ...(kind === 'USAGE' && { meterSlug: 'calls', pricePerUnitCents: 1 }),
      },
    });
    if (included !== undefined) {
      await app.inject({
        method: 'PUT',
        url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
        headers: auth(),
        payload: { kind: 'USAGE', key: 'calls', quantity: included },
      });
    }
    return (await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug } })).id;
  }

  /** The free tier is `billingConfig.defaultPlanSlug`, not a column. */
  async function setDefaultPlan(planId: string): Promise<void> {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    const current = await prisma.application.findUniqueOrThrow({
      where: { id: appId },
      select: { billingConfig: true },
    });
    await prisma.application.update({
      where: { id: appId },
      data: {
        billingConfig: {
          ...(current.billingConfig as Record<string, unknown>),
          defaultPlanSlug: plan.slug,
        },
      },
    });
  }

  it('a credit pack that MENTIONS a feature does not strip the free tier', async () => {
    // The half with no override in it, and the reason the rule is scoped to
    // overrides rather than to resolved state. Buying a credit pack is a top-up,
    // not being on a plan, `suppressesFreeTier` says so and the credit-purchase
    // test pins it. If a plan row could withhold the default, a customer would
    // lose their free tier for topping up, which is the opposite of the intent
    // and would hit subjects who never had an override at all.
    const freePlan = await makePlan('SUBSCRIPTION');
    const freeSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: freePlan } })).slug;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${freeSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'FEATURE', key: 'max_projects', valueType: 'INT', value: '3' },
    });
    await setDefaultPlan(freePlan);

    const eu = await makeEndUser();
    const creditPlan = await makePlan('CREDIT');
    const creditSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: creditPlan } })).slug;
    const planRow = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${creditSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'FEATURE', key: 'max_projects', valueType: 'INT', value: '1' },
    });
    expect(planRow.statusCode).toBe(200);
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: creditPlan, status: 'ACTIVE' },
    });

    const resolved = await entitlementsService.resolveForEndUser(appId, eu);
    // The plan row is really there, otherwise there is nothing for `answered`
    // to find and the mutation this test defends against is undetectable.
    expect(
      resolved.entitlements.some((x) => x.key === 'max_projects' && x.value === '1'),
    ).toBe(true);
    // 3, not 1. No override exists, so the default still applies.
    expect(resolved.features.max_projects).toBe(3);
  });

  it('a credit pack that MENTIONS a meter does not shrink the free quota', async () => {
    const freePlan = await makePlan('SUBSCRIPTION', 1000);
    await setDefaultPlan(freePlan);

    const eu = await makeEndUser();
    const creditPlan = await makePlan('CREDIT');
    const creditSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: creditPlan } })).slug;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${creditSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 500 },
    });
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: creditPlan, status: 'ACTIVE' },
    });

    // Additive, as before: 1500, not 500. Only an override makes the default lose.
    expect(await entitlementsService.includedQuotaFor(appId, { endUserId: eu }, 'calls')).toEqual({
      included: 1500,
      creditsPerUnit: null,
    });
  });

  it("the free tier's per-unit price still floors what a subject is charged", async () => {
    // A change about how many units somebody gets must not move a price. `rate`
    // is a minimum across everything pricing the meter and is what
    // `usage.record` charges, so dropping the default from that minimum would
    // silently raise the bill of a subject on a dearer plan.
    const freePlan = await makePlan('SUBSCRIPTION');
    const freeSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: freePlan } })).slug;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${freeSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 1000, creditsPerUnit: 1 },
    });
    await setDefaultPlan(freePlan);

    const eu = await makeEndUser();
    const creditPlan = await makePlan('CREDIT');
    const creditSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: creditPlan } })).slug;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${creditSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 5000, creditsPerUnit: 4 },
    });
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: creditPlan, status: 'ACTIVE' },
    });
    // Even with the quantity overridden, which DOES withhold the default's units.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/subscriptions/${sub.id}/entitlement-overrides`,
      headers: auth(),
      payload: { 'USAGE:calls': 50 },
    });

    const quota = await entitlementsService.includedQuotaFor(appId, { endUserId: eu }, 'calls');
    expect(quota?.included).toBe(50);
    // 1, not 4. The units moved; the price did not.
    expect(quota?.creditsPerUnit).toBe(1);
  });

  it('a legal zero override on a PRICED meter withholds the default', async () => {
    // The other disjunct of `rowMeaningful`. Here the row keeps its price, so it
    // is meaningful through `creditsPerUnit` rather than through a positive
    // quantity, which is the shape an operator authors deliberately: "no free
    // units, charge from unit one". Drop that disjunct and the override stops
    // counting, the default's 1000 units come back, and the operator who sold
    // charge-from-unit-one gives away a thousand.
    const freePlan = await makePlan('SUBSCRIPTION', 1000);
    await setDefaultPlan(freePlan);

    const eu = await makeEndUser();
    const creditPlan = await makePlan('CREDIT');
    const creditSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: creditPlan } })).slug;
    const priced = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${creditSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 500, creditsPerUnit: 2 },
    });
    expect(priced.statusCode).toBe(200);
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: creditPlan, status: 'ACTIVE' },
    });
    const zeroed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/subscriptions/${sub.id}/entitlement-overrides`,
      headers: auth(),
      payload: { 'USAGE:calls': 0 },
    });
    expect(zeroed.statusCode).toBe(200);

    // Zero, at the row's price. Not 1000, and not 1000 + 0.
    expect(await entitlementsService.includedQuotaFor(appId, { endUserId: eu }, 'calls')).toEqual({
      included: 0,
      creditsPerUnit: 2,
    });
  });

  it('one subscription override does not withhold a default another supplies', async () => {
    // The per-subscription pairing. Sub A carried the meter and was overridden;
    // the row was then dropped from A's plan, so A's override no longer lands.
    // Sub B carries the meter and has no override. Unioned across
    // subscriptions, A's dead override withholds the default anyway.
    const freePlan = await makePlan('SUBSCRIPTION', 1000);
    await setDefaultPlan(freePlan);

    const eu = await makeEndUser();
    const planA = await makePlan('CREDIT');
    const slugA = (await prisma.plan.findUniqueOrThrow({ where: { id: planA } })).slug;
    const rowA = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${slugA}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 300 },
    });
    expect(rowA.statusCode).toBe(200);
    const subA = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: planA, status: 'ACTIVE' },
    });
    const overridden = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/subscriptions/${subA.id}/entitlement-overrides`,
      headers: auth(),
      payload: { 'USAGE:calls': 50 },
    });
    expect(overridden.statusCode).toBe(200);

    // Drop the row A's override was written against, so it now lands nowhere.
    const entA = await prisma.planEntitlement.findFirstOrThrow({
      where: { planId: planA, kind: 'USAGE', key: 'calls' },
    });
    await prisma.planEntitlement.delete({ where: { id: entA.id } });

    // B carries the meter, with no override of its own.
    const planB = await makePlan('CREDIT');
    const slugB = (await prisma.plan.findUniqueOrThrow({ where: { id: planB } })).slug;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${slugB}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 500 },
    });
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: planB, status: 'ACTIVE' },
    });

    // B's 500 plus the default's 1000. A's override landed on nothing, so it
    // withholds nothing. Unioned, this would be 500.
    expect(await entitlementsService.includedQuotaFor(appId, { endUserId: eu }, 'calls')).toEqual({
      included: 1500,
      creditsPerUnit: null,
    });
  });

  it('a zero override still means zero when its price was later cleared', async () => {
    // The drift pair. An operator writes `{"USAGE:calls": 0}` on a PRICED row,
    // legal, "no free units, charge from unit one", and a later plan edit
    // clears the price, because `upsert` writes `creditsPerUnit ?? null` and a
    // PUT changing only the quantity omits it.
    //
    // The resolved row is then (quantity 0, no price), which caps nothing on its
    // own. Treating that as "the override did not land" was tried and is worse:
    // it hands back the default's units, and where there is no default it
    // answers `null`, which every caller reads as unmetered and unbilled. Zero
    // is what the operator wrote and what the webhook announced.
    const freePlan = await makePlan('SUBSCRIPTION', 1000);
    await setDefaultPlan(freePlan);

    const eu = await makeEndUser();
    const creditPlan = await makePlan('CREDIT');
    const creditSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: creditPlan } })).slug;
    const priced = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${creditSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 100, creditsPerUnit: 2 },
    });
    expect(priced.statusCode).toBe(200);
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: creditPlan, status: 'ACTIVE' },
    });
    const zeroed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/subscriptions/${sub.id}/entitlement-overrides`,
      headers: auth(),
      payload: { 'USAGE:calls': 0 },
    });
    expect(zeroed.statusCode).toBe(200);

    // The drift: quantity edited, price silently cleared.
    const cleared = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${creditSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 50 },
    });
    expect(cleared.statusCode).toBe(200);

    const quota = await entitlementsService.includedQuotaFor(appId, { endUserId: eu }, 'calls');
    expect(quota).not.toBeNull();
    expect(quota?.included).toBe(0);
    // Null rate proves the price really cleared, so this is the drift state and
    // not a surviving price doing the capping.
    expect(quota?.creditsPerUnit).toBeNull();
  });

  it('a zero override means zero even with NO free tier configured', async () => {
    // The case that matters most, and the one the free-tier-present test cannot
    // see. With no `defaultPlanSlug` there is nothing to fall back TO, so
    // treating the drift pair as "not overridden" returns `null`, unmetered and
    // unbilled, for the one customer the operator restricted, while every other
    // subscriber on the same plan stays capped. Silent, and nothing logs it.
    const eu = await makeEndUser();
    const creditPlan = await makePlan('CREDIT');
    const creditSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: creditPlan } })).slug;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${creditSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 100, creditsPerUnit: 2 },
    });
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: creditPlan, status: 'ACTIVE' },
    });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/tenant/applications/${appId}/subscriptions/${sub.id}/entitlement-overrides`,
          headers: auth(),
          payload: { 'USAGE:calls': 0 },
        })
      ).statusCode,
    ).toBe(200);
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${creditSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 50 },
    });

    // Capped at zero. NOT null.
    const quota = await entitlementsService.includedQuotaFor(appId, { endUserId: eu }, 'calls');
    expect(quota).not.toBeNull();
    expect(quota).toEqual({ included: 0, creditsPerUnit: null });
  });

  it('a legal zero override on a PRICED meter withholds the default', async () => {
    // The other disjunct of `rowMeaningful`. Here the row keeps its price, so it
    // is meaningful through `creditsPerUnit` rather than through a positive
    // quantity, which is the shape an operator authors deliberately: "no free
    // units, charge from unit one". Drop that disjunct and the override stops
    // counting, the default's 1000 units come back, and the operator who sold
    // charge-from-unit-one gives away a thousand.
    const freePlan = await makePlan('SUBSCRIPTION', 1000);
    await setDefaultPlan(freePlan);

    const eu = await makeEndUser();
    const creditPlan = await makePlan('CREDIT');
    const creditSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: creditPlan } })).slug;
    const priced = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${creditSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 500, creditsPerUnit: 2 },
    });
    expect(priced.statusCode).toBe(200);
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: creditPlan, status: 'ACTIVE' },
    });
    const zeroed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/subscriptions/${sub.id}/entitlement-overrides`,
      headers: auth(),
      payload: { 'USAGE:calls': 0 },
    });
    expect(zeroed.statusCode).toBe(200);

    // Zero, at the row's price. Not 1000, and not 1000 + 0.
    expect(await entitlementsService.includedQuotaFor(appId, { endUserId: eu }, 'calls')).toEqual({
      included: 0,
      creditsPerUnit: 2,
    });
  });

  it('one subscription override does not withhold a default another supplies', async () => {
    // The per-subscription pairing. Sub A carried the meter and was overridden;
    // the row was then dropped from A's plan, so A's override no longer lands.
    // Sub B carries the meter and has no override. Unioned across
    // subscriptions, A's dead override withholds the default anyway.
    const freePlan = await makePlan('SUBSCRIPTION', 1000);
    await setDefaultPlan(freePlan);

    const eu = await makeEndUser();
    const planA = await makePlan('CREDIT');
    const slugA = (await prisma.plan.findUniqueOrThrow({ where: { id: planA } })).slug;
    const rowA = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${slugA}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 300 },
    });
    expect(rowA.statusCode).toBe(200);
    const subA = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: planA, status: 'ACTIVE' },
    });
    const overridden = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/subscriptions/${subA.id}/entitlement-overrides`,
      headers: auth(),
      payload: { 'USAGE:calls': 50 },
    });
    expect(overridden.statusCode).toBe(200);

    // Drop the row A's override was written against, so it now lands nowhere.
    const entA = await prisma.planEntitlement.findFirstOrThrow({
      where: { planId: planA, kind: 'USAGE', key: 'calls' },
    });
    await prisma.planEntitlement.delete({ where: { id: entA.id } });

    // B carries the meter, with no override of its own.
    const planB = await makePlan('CREDIT');
    const slugB = (await prisma.plan.findUniqueOrThrow({ where: { id: planB } })).slug;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${slugB}/entitlements`,
      headers: auth(),
      payload: { kind: 'USAGE', key: 'calls', quantity: 500 },
    });
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: planB, status: 'ACTIVE' },
    });

    // B's 500 plus the default's 1000. A's override landed on nothing, so it
    // withholds nothing. Unioned, this would be 500.
    expect(await entitlementsService.includedQuotaFor(appId, { endUserId: eu }, 'calls')).toEqual({
      included: 1500,
      creditsPerUnit: null,
    });
  });

  it('refuses an empty-string override, and still falls back on a stored one', async () => {
    // Two halves of one rule. `''` survives `parseFeatureValue` but every
    // `if (features.x)` gate reads it as absent, and the plan-level `validate`
    // refuses it, so a plan can never carry one.
    //
    // The write path refuses it, which is the module's stated invariant: it
    // "refuses what the read path would ignore". The read path skips it anyway,
    // for rows written before that refusal existed or by hand.
    const freePlan = await makePlan('SUBSCRIPTION');
    const freeSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: freePlan } })).slug;
    const freeRow = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${freeSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'FEATURE', key: 'tier', valueType: 'STRING', value: 'community' },
    });
    expect(freeRow.statusCode).toBe(200);
    await setDefaultPlan(freePlan);

    const eu = await makeEndUser();
    const creditPlan = await makePlan('CREDIT');
    const creditSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: creditPlan } })).slug;
    const planRow = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${creditSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'FEATURE', key: 'tier', valueType: 'STRING', value: 'pro' },
    });
    expect(planRow.statusCode).toBe(200);
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: creditPlan, status: 'ACTIVE' },
    });

    // Half one: refused, and the fix names the remedy that actually works.
    const blanked = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/subscriptions/${sub.id}/entitlement-overrides`,
      headers: auth(),
      payload: { 'FEATURE:tier': '' },
    });
    expect(blanked.statusCode).toBe(400);
    const err = blanked.json().error as { code: string; fix: string };
    expect(err.code).toBe('ENTITLEMENT_OVERRIDE_INVALID');
    expect(err.fix).toMatch(/`null`/);

    // Half two: a row that predates the refusal still resolves to the default,
    // not to '' and not to undefined.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { entitlementOverrides: { 'FEATURE:tier': '' } },
    });
    const resolved = await entitlementsService.resolveForEndUser(appId, eu);
    expect(resolved.features.tier).toBe('community');
  });

  it('a STRING feature follows createdAt, not the order rows happen to sit in', async () => {
    // The order has to DISAGREE with insertion order or this test proves
    // nothing. `test/setup.ts` truncates before every test, so two fresh rows
    // come back from a seq scan in insertion order, which is already
    // `createdAt asc`, and `cuid()` is monotonic, so the `id` tie-break agrees
    // too. A previous version of this test created them in order and passed
    // identically with the `orderBy` deleted.
    //
    // So the row inserted SECOND is stamped OLDER. Without the `orderBy`,
    // physical order wins and the answer is 'priority'. With it, `createdAt asc`
    // wins and the answer is 'community'.
    const eu = await makeEndUser();
    const newer = await makePlan('CREDIT');
    const older = await makePlan('CREDIT');
    for (const [id, value] of [
      [newer, 'priority'],
      [older, 'community'],
    ] as const) {
      const slug = (await prisma.plan.findUniqueOrThrow({ where: { id } })).slug;
      const put = await app.inject({
        method: 'PUT',
        url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
        headers: auth(),
        payload: { kind: 'FEATURE', key: 'support_tier', valueType: 'STRING', value },
      });
      expect(put.statusCode).toBe(200);
    }
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: newer, status: 'ACTIVE' },
    });
    await prisma.subscription.create({
      data: {
        applicationId: appId,
        endUserId: eu,
        planId: older,
        status: 'ACTIVE',
        createdAt: new Date(Date.now() - 60_000),
      },
    });

    // Last by createdAt wins the last-wins merge: the NEWER subscription.
    const resolved = await entitlementsService.resolveForEndUser(appId, eu);
    expect(resolved.features.support_tier).toBe('priority');
  });

  it('the free tier does not overwrite a STRING the subscription already sets', async () => {
    // The merge is last-wins for STRING, so a default appended LAST did not fill
    // a gap, it replaced: an Application whose free tier said "community"
    // downgraded a paying subscriber whose plan said "priority". Numbers and
    // booleans hid this because max and OR-true are order-independent.
    const freePlan = await makePlan('SUBSCRIPTION');
    const freeSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: freePlan } })).slug;
    const freeRow = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${freeSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'FEATURE', key: 'support_tier', valueType: 'STRING', value: 'community' },
    });
    expect(freeRow.statusCode).toBe(200);
    await setDefaultPlan(freePlan);

    const eu = await makeEndUser();
    const paid = await makePlan('CREDIT');
    const paidSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: paid } })).slug;
    const paidRow = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${paidSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'FEATURE', key: 'support_tier', valueType: 'STRING', value: 'priority' },
    });
    expect(paidRow.statusCode).toBe(200);
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: paid, status: 'ACTIVE' },
    });

    // What they bought, with no override anywhere.
    const resolved = await entitlementsService.resolveForEndUser(appId, eu);
    expect(resolved.features.support_tier).toBe('priority');
  });

  it('a STRING feature resolves the same way twice, across two subscriptions', async () => {
    // STRING features merge last-wins and the winner used to be Postgres row
    // order, so a subject holding two plans could see a value change between
    // page loads with nothing having changed. Two subscriptions is also the
    // shape nothing else in the suite covers.
    const eu = await makeEndUser();
    const first = await makePlan('CREDIT');
    const second = await makePlan('CREDIT');
    for (const [id, value] of [
      [first, 'community'],
      [second, 'priority'],
    ] as const) {
      const slug = (await prisma.plan.findUniqueOrThrow({ where: { id } })).slug;
      const put = await app.inject({
        method: 'PUT',
        url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
        headers: auth(),
        payload: { kind: 'FEATURE', key: 'support_tier', valueType: 'STRING', value },
      });
      expect(put.statusCode).toBe(200);
      await prisma.subscription.create({
        data: { applicationId: appId, endUserId: eu, planId: id, status: 'ACTIVE' },
      });
    }

    const a = await entitlementsService.resolveForEndUser(appId, eu);
    const b = await entitlementsService.resolveForEndUser(appId, eu);
    // Ordered by createdAt, so the later-created plan wins, every time.
    expect(a.features.support_tier).toBe('priority');
    expect(b.features.support_tier).toBe(a.features.support_tier);
  });

  it('a feature whose override cannot be parsed falls back rather than vanishing', async () => {
    // `answered` has to mean "resolved to something". The merge drops a row
    // whose value fails to parse, and the ADD path does not type check a key the
    // plan lacks, so a STRING override can later meet an INT plan row. Counting
    // that as answered withheld the default and made the key disappear
    // entirely, which is worse than either value.
    const freePlan = await makePlan('SUBSCRIPTION');
    const freeSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: freePlan } })).slug;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${freeSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'FEATURE', key: 'tier', valueType: 'STRING', value: 'community' },
    });
    await setDefaultPlan(freePlan);

    const eu = await makeEndUser();
    const creditPlan = await makePlan('CREDIT');
    const creditSlug = (await prisma.plan.findUniqueOrThrow({ where: { id: creditPlan } })).slug;
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: eu, planId: creditPlan, status: 'ACTIVE' },
    });
    // ADD a key the plan does not carry: no type assertion applies. Asserted,
    // because without the override existing the merge still lands on
    // 'community' by last-wins and the test would pass having proved nothing.
    const added = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/subscriptions/${sub.id}/entitlement-overrides`,
      headers: auth(),
      payload: { 'FEATURE:tier': 'gold' },
    });
    expect(added.statusCode).toBe(200);
    // Now the plan grows an INT row of the same name, so "gold" stops parsing.
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${creditSlug}/entitlements`,
      headers: auth(),
      payload: { kind: 'FEATURE', key: 'tier', valueType: 'INT', value: '5' },
    });

    const resolved = await entitlementsService.resolveForEndUser(appId, eu);
    // The free tier's value, not `undefined`.
    expect(resolved.features.tier).toBe('community');
  });

});
