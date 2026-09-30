/**
 * A signed-up user of a freemium product gets their free tier, on an
 * Application with no payment provider configured at all.
 *
 * The gap this closes, reported by an integrator who could not launch: their
 * free tier is a CREDIT entitlement, CREDIT materialises only from a real
 * subscription, `createCheckoutSession` always routes through a provider, and
 * `pickProvider` throws when none is configured. So there was no way to put
 * anybody on the free plan, and a new signup received nothing. Every plan
 * reported `NO_BILLING_PROVIDER`, including the one costing nothing.
 *
 * `billingConfig.defaultPlanSlug` covers the READ-time half, feature flags and
 * included usage quota, and deliberately not the stateful half, because a
 * credit grant and a licence need a period to anchor to. This is that period.
 *
 * Per #392: a provider answers "charge once now" and "start recurring later",
 * and a free plan asks neither, so none is consulted.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';
import { usageService } from '../src/modules/usage/usage.service.js';

const PASSWORD = 'pw-one-two-three';

describe('self-serve free tier', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let pubKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    const slug = `ft${Math.random().toString(36).slice(2, 7)}`;
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: auth(),
      payload: { name: 'FT', slug, enableBilling: true },
    });
    appId = (created.json().data as { id: string }).id;
    pubKey = (await prisma.application.findUniqueOrThrow({ where: { id: appId } })).publicKey;
  });

  /** A plan, optionally with one entitlement, and no provider anywhere. */
  async function makePlan(
    body: Record<string, unknown>,
    entitlement?: Record<string, unknown>,
  ): Promise<string> {
    const slug = body.slug as string;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: body,
    });
    if (res.statusCode !== 201) throw new Error(`createPlan ${res.statusCode}: ${res.body}`);
    if (entitlement) {
      await app.inject({
        method: 'PUT',
        url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
        headers: auth(),
        payload: entitlement,
      });
    }
    return slug;
  }

  async function nominate(slug: string | null): Promise<void> {
    const current = await prisma.application.findUniqueOrThrow({
      where: { id: appId },
      select: { billingConfig: true },
    });
    const cfg = { ...(current.billingConfig as Record<string, unknown>) };
    if (slug === null) delete cfg.defaultPlanSlug;
    else cfg.defaultPlanSlug = slug;
    await prisma.application.update({ where: { id: appId }, data: { billingConfig: cfg as Prisma.InputJsonValue } });
  }

  /** A signed-up end-user and their access token, via the publishable key. */
  async function signUp(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${pubKey}` },
      payload: { email: `u-${Math.random().toString(36).slice(2, 8)}@example.com`, password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { accessToken: string }).accessToken;
  }

  const subscribe = (userToken: string, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscribe',
      headers: { authorization: `Bearer ${pubKey}`, 'x-rekey-user-token': userToken },
      payload,
    });

  it('gives a new signup their included credits with no provider configured', async () => {
    // The reported case, end to end.
    const slug = await makePlan(
      { slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' },
      { kind: 'CREDIT', quantity: 500 },
    );
    await nominate(slug);
    const userToken = await signUp();

    // Nothing before: CREDIT is stateful and the read-time fallback withholds it.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/entitlements',
      headers: { authorization: `Bearer ${pubKey}`, 'x-rekey-user-token': userToken },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json().data as { creditBalance: number }).creditBalance).toBe(0);

    const res = await subscribe(userToken);
    expect(res.statusCode).toBe(201);

    // The credits actually landed, which is the whole point.
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/entitlements',
      headers: { authorization: `Bearer ${pubKey}`, 'x-rekey-user-token': userToken },
    });
    expect((after.json().data as { creditBalance: number }).creditBalance).toBe(500);

    // And no provider was invented to do it.
    const sub = await prisma.subscription.findFirstOrThrow({
      where: { applicationId: appId },
    });
    expect(sub.provider).toBeNull();
    expect(sub.status).toBe('ACTIVE');
  });

  it('is idempotent: a second call changes nothing and re-grants nothing', async () => {
    const slug = await makePlan(
      { slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' },
      { kind: 'CREDIT', quantity: 500 },
    );
    await nominate(slug);
    const userToken = await signUp();

    expect((await subscribe(userToken)).statusCode).toBe(201);
    const again = await subscribe(userToken);
    expect(again.statusCode).toBe(200);

    // 500, not 1000. A repeat activation must not mint a second grant.
    const bal = await entitlementsService.resolveForEndUser(
      appId,
      (await prisma.endUser.findFirstOrThrow({ where: { applicationId: appId } })).id,
    );
    expect(bal.creditBalance).toBe(500);
    expect(await prisma.subscription.count({ where: { applicationId: appId } })).toBe(1);
  });

  it('refuses a nominated plan that charges an amount', async () => {
    const slug = await makePlan({ slug: 'paid', name: 'Paid', amount: 1000, kind: 'SUBSCRIPTION' });
    await nominate(slug);
    const res = await subscribe(await signUp());
    expect(res.statusCode).toBe(409);
    expect((res.json().error as { code: string }).code).toBe('BILLING_FREE_PLAN_NOT_FREE');
  });

  it('refuses a nominated plan that is free only in the headline', async () => {
    // `amount: 0` with a per-unit price is metered, not free. This is half of
    // why the guard is not `amount === 0`.
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/usage-meters`,
      headers: auth(),
      payload: { slug: 'calls', name: 'Calls', unit: 'call' },
    });
    const slug = await makePlan({
      slug: 'metered',
      name: 'Metered',
      amount: 0,
      kind: 'USAGE',
      meterSlug: 'calls',
      pricePerUnitCents: 5,
    });
    await nominate(slug);
    const res = await subscribe(await signUp());
    expect(res.statusCode).toBe(409);
    expect((res.json().error as { code: string }).code).toBe('BILLING_FREE_PLAN_NOT_FREE');
  });

  it('refuses when the Application nominates no free tier', async () => {
    await makePlan({ slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' });
    await nominate(null);
    const res = await subscribe(await signUp());
    expect(res.statusCode).toBe(404);
    expect((res.json().error as { code: string }).code).toBe('BILLING_NO_FREE_PLAN');
  });

  it('reaches only the nominated plan, never another free one', async () => {
    // The guard is nomination, not price: a second zero-amount plan carrying a
    // richer entitlement must not be self-activatable just because it is free.
    const free = await makePlan(
      { slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' },
      { kind: 'CREDIT', quantity: 10 },
    );
    await makePlan(
      { slug: 'generous', name: 'Generous', amount: 0, kind: 'SUBSCRIPTION' },
      { kind: 'CREDIT', quantity: 100_000 },
    );
    await nominate(free);
    const userToken = await signUp();
    expect((await subscribe(userToken)).statusCode).toBe(201);

    const sub = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } });
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: sub.planId } });
    expect(plan.slug).toBe('free');
  });

  it('needs the buyer, not just the Application key', async () => {
    const slug = await makePlan({ slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' });
    await nominate(slug);
    // No user token: the actor has to be the beneficiary.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscribe',
      headers: { authorization: `Bearer ${pubKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  describe('a free plan that hands over value is claimed once per person', () => {
    async function enableOrgs(): Promise<void> {
      const cur = await prisma.application.findUniqueOrThrow({
        where: { id: appId },
        select: { authConfig: true },
      });
      await prisma.application.update({
        where: { id: appId },
        data: {
          authConfig: { ...(cur.authConfig as object), organizationsEnabled: true } as Prisma.InputJsonValue,
        },
      });
    }

    const userHeaders = (userToken: string) => ({
      authorization: `Bearer ${pubKey}`,
      'x-rekey-user-token': userToken,
    });

    async function createOrg(userToken: string): Promise<string> {
      const suffix = Math.random().toString(36).slice(2, 8);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations/',
        headers: userHeaders(userToken),
        payload: { name: `Org ${suffix}`, slug: `org-${suffix}` },
      });
      expect(res.statusCode).toBe(201);
      const data = res.json().data as { id?: string; organization?: { id: string } };
      return (data.organization?.id ?? data.id)!;
    }

    async function cancelNow(userToken: string, organizationId?: string): Promise<void> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/subscription/cancel',
        headers: userHeaders(userToken),
        payload: { atPeriodEnd: false, ...(organizationId && { organizationId }) },
      });
      expect(res.statusCode).toBe(200);
    }

    const purchaseRows = () =>
      prisma.creditLedger.findMany({ where: { applicationId: appId, delta: { gt: 0 } } });

    it('refuses the second beneficiary, so cancel and create an org no longer mints credits', async () => {
      await nominate(
        await makePlan({ slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' }, { kind: 'CREDIT', quantity: 500 }),
      );
      await enableOrgs();
      const userToken = await signUp();

      expect((await subscribe(userToken)).statusCode).toBe(201);
      await cancelNow(userToken);

      for (let i = 0; i < 3; i++) {
        const orgId = await createOrg(userToken);
        const res = await subscribe(userToken, { organizationId: orgId });
        expect(res.statusCode).toBe(409);
        expect((res.json().error as { code: string }).code).toBe('BILLING_FREE_TIER_ALREADY_CLAIMED');
      }

      const rows = await purchaseRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.delta).toBe(500);
      expect(rows[0]!.organizationId).toBeNull();
      // The refused activations did not move the row off the personal account.
      const sub = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } });
      expect(sub.beneficiaryOrgId).toBeNull();
      expect(await prisma.freeTierClaim.count({ where: { applicationId: appId } })).toBe(1);
    });

    it('refuses the personal account after an organization took the claim', async () => {
      await nominate(
        await makePlan({ slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' }, { kind: 'CREDIT', quantity: 500 }),
      );
      await enableOrgs();
      const userToken = await signUp();
      const orgId = await createOrg(userToken);

      expect((await subscribe(userToken, { organizationId: orgId })).statusCode).toBe(201);
      await cancelNow(userToken, orgId);
      const res = await subscribe(userToken);
      expect(res.statusCode).toBe(409);
      expect((res.json().error as { code: string }).code).toBe('BILLING_FREE_TIER_ALREADY_CLAIMED');
      expect(await purchaseRows()).toHaveLength(1);
    });

    it('treats a LICENSE free plan the same way: one licence, not one per org', async () => {
      await nominate(
        await makePlan(
          { slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' },
          { kind: 'LICENSE', licenseKind: 'SEATS', quantity: 3 },
        ),
      );
      const ent = await prisma.planEntitlement.count({ where: { kind: 'LICENSE', plan: { applicationId: appId } } });
      expect(ent).toBe(1);
      await enableOrgs();
      const userToken = await signUp();
      const orgA = await createOrg(userToken);
      const orgB = await createOrg(userToken);

      expect((await subscribe(userToken, { organizationId: orgA })).statusCode).toBe(201);
      expect(await prisma.license.count({ where: { applicationId: appId } })).toBe(1);

      await cancelNow(userToken, orgA);
      const res = await subscribe(userToken, { organizationId: orgB });
      expect(res.statusCode).toBe(409);
      expect((res.json().error as { code: string }).code).toBe('BILLING_FREE_TIER_ALREADY_CLAIMED');
      expect(await prisma.license.count({ where: { applicationId: appId } })).toBe(1);
      expect(await prisma.license.count({ where: { applicationId: appId, organizationId: orgB } })).toBe(0);
    });

    it('lets the same beneficiary cancel and come back without a second grant', async () => {
      await nominate(
        await makePlan({ slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' }, { kind: 'CREDIT', quantity: 500 }),
      );
      await enableOrgs();
      const userToken = await signUp();
      const orgId = await createOrg(userToken);

      expect((await subscribe(userToken, { organizationId: orgId })).statusCode).toBe(201);
      for (let i = 0; i < 2; i++) {
        await cancelNow(userToken, orgId);
        const back = await subscribe(userToken, { organizationId: orgId });
        expect(back.statusCode).toBe(201);
        expect((back.json().data as { status: string }).status).toBe('ACTIVE');
      }

      const rows = await purchaseRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.organizationId).toBe(orgId);
      const balance = await entitlementsService.resolveForEndUser(
        appId,
        (await prisma.endUser.findFirstOrThrow({ where: { applicationId: appId } })).id,
        { organizationId: orgId },
      );
      expect(balance.creditBalance).toBe(500);
    });

    it('leaves a FEATURE-only free plan activatable for several organizations', async () => {
      await nominate(
        await makePlan(
          { slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' },
          { kind: 'FEATURE', key: 'basic', valueType: 'BOOL', value: 'true' },
        ),
      );
      await enableOrgs();
      const userToken = await signUp();

      expect((await subscribe(userToken)).statusCode).toBe(201);
      let prevOrg: string | undefined;
      for (let i = 0; i < 3; i++) {
        const orgId = await createOrg(userToken);
        await cancelNow(userToken, prevOrg);
        const res = await subscribe(userToken, { organizationId: orgId });
        expect(res.statusCode).toBe(201);
        expect((res.json().data as { beneficiaryOrgId: string }).beneficiaryOrgId).toBe(orgId);
        prevOrg = orgId;
      }
      expect(await prisma.freeTierClaim.count({ where: { applicationId: appId } })).toBe(0);
    });

    async function billPerOrganization(): Promise<void> {
      const cur = await prisma.application.findUniqueOrThrow({ where: { id: appId }, select: { billingConfig: true } });
      await prisma.application.update({
        where: { id: appId },
        data: {
          billingConfig: { ...(cur.billingConfig as object), billingSubject: 'org' } as Prisma.InputJsonValue,
        },
      });
    }

    async function orgFeatures(userToken: string, organizationId: string): Promise<Record<string, unknown>> {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/billing/entitlements?organizationId=${organizationId}`,
        headers: userHeaders(userToken),
      });
      expect(res.statusCode).toBe(200);
      return (res.json().data as { features: Record<string, unknown> }).features;
    }

    it('puts a second organization on a FEATURE-only free tier without answering with the first one\'s subscription', async () => {
      await nominate(
        await makePlan(
          { slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' },
          { kind: 'FEATURE', key: 'basic', valueType: 'BOOL', value: 'true' },
        ),
      );
      await enableOrgs();
      await billPerOrganization();
      const userToken = await signUp();
      const org1 = await createOrg(userToken);
      const org2 = await createOrg(userToken);

      const first = await subscribe(userToken, { organizationId: org1 });
      expect(first.statusCode, first.body).toBe(201);
      expect(first.json().data).toMatchObject({ beneficiaryOrgId: org1, activated: true });

      const second = await subscribe(userToken, { organizationId: org2 });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().data).toBeNull();
      expect((await orgFeatures(userToken, org2)).basic).toBe(true);

      const again = await subscribe(userToken, { organizationId: org1 });
      expect(again.statusCode).toBe(200);
      expect(again.json().data).toMatchObject({ beneficiaryOrgId: org1, activated: false });
      expect(await prisma.subscription.count({ where: { applicationId: appId } })).toBe(1);
    });

    it('never hands one of eight concurrent FEATURE-only activations another organization\'s subscription', async () => {
      await nominate(
        await makePlan(
          { slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' },
          { kind: 'FEATURE', key: 'basic', valueType: 'BOOL', value: 'true' },
        ),
      );
      await enableOrgs();
      await billPerOrganization();
      const userToken = await signUp();
      const orgs: string[] = [];
      for (let i = 0; i < 8; i++) orgs.push(await createOrg(userToken));

      const results = await Promise.all(orgs.map((organizationId) => subscribe(userToken, { organizationId })));
      const created = results.filter((r) => r.statusCode === 201);
      expect(created).toHaveLength(1);
      const others = results.filter((r) => r.statusCode !== 201);
      expect(others.map((r) => r.statusCode)).toEqual(Array(7).fill(200));
      for (const r of others) expect(r.json().data).toBeNull();
      for (const organizationId of orgs) expect((await orgFeatures(userToken, organizationId)).basic).toBe(true);
    });

    describe('the organization free-tier claim', () => {
      async function freeWithQuota(): Promise<void> {
        await nominate(
          await makePlan(
            { slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' },
            { kind: 'FEATURE', key: 'basic', valueType: 'BOOL', value: 'true' },
          ),
        );
        await prisma.usageMeter.create({ data: { applicationId: appId, slug: 'calls', name: 'Calls', unit: 'calls' } });
        const r = await app.inject({
          method: 'PUT',
          url: `/api/v1/tenant/applications/${appId}/plans/free/entitlements`,
          headers: auth(),
          payload: { kind: 'USAGE', key: 'calls', quantity: 100, creditsPerUnit: 2 },
        });
        expect(r.statusCode, r.body).toBe(200);
      }

      const quota = (organizationId: string) =>
        entitlementsService.includedQuotaFor(appId, { organizationId }, 'calls');

      it('gives an unclaimed organization nothing, as before claims existed', async () => {
        await freeWithQuota();
        await enableOrgs();
        await billPerOrganization();
        const userToken = await signUp();
        const orgs = [await createOrg(userToken), await createOrg(userToken), await createOrg(userToken)];
        for (const organizationId of orgs) {
          expect((await orgFeatures(userToken, organizationId)).basic).toBeUndefined();
          expect(await quota(organizationId)).toBeNull();
        }
      });

      it('gives a claimed organization the features and included quantity, but never the per-unit rate', async () => {
        await freeWithQuota();
        await enableOrgs();
        await billPerOrganization();
        const userToken = await signUp();
        const holder = await createOrg(userToken);
        const claimed = await createOrg(userToken);
        const unclaimed = await createOrg(userToken);
        // The first organization holds the free plan's subscription row; the
        // second is on it through its claim alone, which is the fallback path.
        expect((await subscribe(userToken, { organizationId: holder })).statusCode).toBe(201);
        expect((await subscribe(userToken, { organizationId: claimed })).statusCode).toBe(200);

        expect((await orgFeatures(userToken, claimed)).basic).toBe(true);
        expect(await quota(claimed)).toEqual({ included: 100, creditsPerUnit: null });
        expect((await orgFeatures(userToken, unclaimed)).basic).toBeUndefined();
        expect(await quota(unclaimed)).toBeNull();

        // Past the allowance an organization is capped, not charged from the
        // free tier's rate.
        const over = await usageService
          .record({ applicationId: appId, meterSlug: 'calls', quantity: 150, organizationId: claimed })
          .catch((e: { code?: string }) => e);
        expect((over as { code?: string }).code).toBe('USAGE_QUOTA_EXCEEDED');
        expect(await prisma.creditLedger.count({ where: { applicationId: appId, delta: { lt: 0 } } })).toBe(0);
      });

      it('gives an organization on a per-user Application nothing, even after a subscribe naming it', async () => {
        await freeWithQuota();
        await enableOrgs();
        const userToken = await signUp();
        expect((await subscribe(userToken)).statusCode).toBe(201);
        const orgId = await createOrg(userToken);
        const res = await subscribe(userToken, { organizationId: orgId });
        expect(res.statusCode).toBe(200);
        expect(res.json().data).toBeNull();
        expect((await orgFeatures(userToken, orgId)).basic).toBeUndefined();
        expect(await quota(orgId)).toBeNull();
        expect(await prisma.organizationFreeTierClaim.count()).toBe(0);

        // A claim left over from when the Application billed per organization
        // does not apply once it bills per user.
        const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'free' } });
        const eu = await prisma.endUser.findFirstOrThrow({ where: { applicationId: appId } });
        await prisma.organizationFreeTierClaim.create({
          data: { applicationId: appId, organizationId: orgId, planId: plan.id, claimedByEndUserId: eu.id },
        });
        expect((await orgFeatures(userToken, orgId)).basic).toBeUndefined();
        expect(await quota(orgId)).toBeNull();
      });

      it('is idempotent: eight racing claims and a second admin leave one claim and one subscription', async () => {
        await freeWithQuota();
        await enableOrgs();
        await billPerOrganization();
        const owner = await signUp();
        const orgId = await createOrg(owner);
        const results = await Promise.all(Array.from({ length: 8 }, () => subscribe(owner, { organizationId: orgId })));
        expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
        expect(results.filter((r) => r.statusCode === 200)).toHaveLength(7);

        const adminToken = await signUp();
        const admin = await prisma.endUser.findFirstOrThrow({
          where: { applicationId: appId },
          orderBy: { createdAt: 'desc' },
        });
        await prisma.organizationMembership.create({ data: { organizationId: orgId, endUserId: admin.id, role: 'ADMIN' } });
        const second = await subscribe(adminToken, { organizationId: orgId });
        expect(second.statusCode, second.body).toBe(200);
        expect(second.json().data).toMatchObject({ beneficiaryOrgId: orgId, activated: false });
        expect((second.json().data as { id: string }).id).toBe((results.find((r) => r.statusCode === 201)!.json().data as { id: string }).id);

        expect(await prisma.organizationFreeTierClaim.count({ where: { organizationId: orgId } })).toBe(1);
        expect(await prisma.subscription.count({ where: { applicationId: appId, beneficiaryOrgId: orgId } })).toBe(1);
      });

      for (const kind of ['FEATURE', 'CREDIT'] as const) {
        it(`eight different admins racing for one organization (${kind} plan): one row, one claim, one grant`, async () => {
          if (kind === 'FEATURE') await freeWithQuota();
          else {
            await nominate(
              await makePlan({ slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' }, { kind: 'CREDIT', quantity: 500 }),
            );
          }
          await enableOrgs();
          await billPerOrganization();
          const owner = await signUp();
          const orgId = await createOrg(owner);
          const tokens: string[] = [owner];
          for (let i = 1; i < 8; i++) {
            tokens.push(await signUp());
            const admin = await prisma.endUser.findFirstOrThrow({ where: { applicationId: appId }, orderBy: { createdAt: 'desc' } });
            await prisma.organizationMembership.create({ data: { organizationId: orgId, endUserId: admin.id, role: 'ADMIN' } });
          }

          const results = await Promise.all(tokens.map((t) => subscribe(t, { organizationId: orgId })));
          expect(results.filter((r) => r.statusCode === 201), results.map((r) => r.body).join('\n')).toHaveLength(1);
          expect(results.filter((r) => r.statusCode === 200)).toHaveLength(7);
          expect(await prisma.subscription.count({ where: { applicationId: appId, beneficiaryOrgId: orgId } })).toBe(1);
          expect(await prisma.organizationFreeTierClaim.count({ where: { organizationId: orgId } })).toBe(1);
          if (kind === 'CREDIT') {
            expect(await prisma.creditLedger.count({ where: { applicationId: appId, delta: { gt: 0 } } })).toBe(1);
          }
        });
      }

      it('caps a claimed organization at zero on a priced free row with no included units, never unmetered', async () => {
        await nominate(
          await makePlan(
            { slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' },
            { kind: 'FEATURE', key: 'basic', valueType: 'BOOL', value: 'true' },
          ),
        );
        await prisma.usageMeter.create({ data: { applicationId: appId, slug: 'calls', name: 'Calls', unit: 'calls' } });
        const r = await app.inject({
          method: 'PUT',
          url: `/api/v1/tenant/applications/${appId}/plans/free/entitlements`,
          headers: auth(),
          payload: { kind: 'USAGE', key: 'calls', quantity: 0, creditsPerUnit: 3 },
        });
        expect(r.statusCode, r.body).toBe(200);
        await enableOrgs();
        await billPerOrganization();
        const userToken = await signUp();
        const holder = await createOrg(userToken);
        const claimed = await createOrg(userToken);
        expect((await subscribe(userToken, { organizationId: holder })).statusCode).toBe(201);
        expect((await subscribe(userToken, { organizationId: claimed })).statusCode).toBe(200);
        expect(await quota(claimed)).toEqual({ included: 0, creditsPerUnit: null });
      });

      it('keeps the claim when the claimed plan is deleted, so it follows the new default', async () => {
        await freeWithQuota();
        await enableOrgs();
        await billPerOrganization();
        const userToken = await signUp();
        const orgId = await createOrg(userToken);
        expect((await subscribe(userToken, { organizationId: orgId })).statusCode).toBe(201);
        await makePlan(
          { slug: 'free2', name: 'Free 2', amount: 0, kind: 'SUBSCRIPTION' },
          { kind: 'FEATURE', key: 'second', valueType: 'BOOL', value: 'true' },
        );
        await nominate('free2');
        await prisma.subscription.deleteMany({ where: { applicationId: appId } });
        await prisma.plan.delete({ where: { applicationId_slug: { applicationId: appId, slug: 'free' } } });

        expect(await prisma.organizationFreeTierClaim.count({ where: { organizationId: orgId } })).toBe(1);
        expect(await orgFeatures(userToken, orgId)).toMatchObject({ second: true });
      });

      it('follows the current default plan, and clearing it removes the fallback', async () => {
        await freeWithQuota();
        await enableOrgs();
        await billPerOrganization();
        const userToken = await signUp();
        const orgId = await createOrg(userToken);
        expect((await subscribe(userToken, { organizationId: orgId })).statusCode).toBe(201);
        await makePlan(
          { slug: 'free2', name: 'Free 2', amount: 0, kind: 'SUBSCRIPTION' },
          { kind: 'FEATURE', key: 'second', valueType: 'BOOL', value: 'true' },
        );
        await prisma.subscription.updateMany({ where: { applicationId: appId }, data: { status: 'CANCELED' } });
        await nominate('free2');
        expect(await orgFeatures(userToken, orgId)).toMatchObject({ second: true });
        await nominate(null);
        expect((await orgFeatures(userToken, orgId)).second).toBeUndefined();
      });

      it('still ranks a paid subscription over the free one for a claimed organization', async () => {
        await freeWithQuota();
        await makePlan({ slug: 'pro', name: 'Pro', amount: 0, kind: 'SUBSCRIPTION' });
        await prisma.plan.update({ where: { applicationId_slug: { applicationId: appId, slug: 'pro' } }, data: { amount: 2900 } });
        await enableOrgs();
        await billPerOrganization();
        const userToken = await signUp();
        const orgId = await createOrg(userToken);
        expect((await subscribe(userToken, { organizationId: orgId })).statusCode).toBe(201);
        const euId = (await prisma.endUser.findFirstOrThrow({ where: { applicationId: appId } })).id;
        const grant = await app.inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${appId}/end-users/${euId}/subscriptions`,
          headers: auth(),
          payload: { planSlug: 'pro', organizationId: orgId },
        });
        expect(grant.statusCode, grant.body).toBe(201);
        const current = await app.inject({
          method: 'GET',
          url: `/api/v1/billing/subscription?organizationId=${orgId}`,
          headers: userHeaders(userToken),
        });
        const pro = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'pro' } });
        expect((current.json().data as { planId: string }).planId).toBe(pro.id);
      });
    });

    it('lets exactly one of eight concurrent claims for different organizations through', async () => {
      await nominate(
        await makePlan({ slug: 'free', name: 'Free', amount: 0, kind: 'SUBSCRIPTION' }, { kind: 'CREDIT', quantity: 500 }),
      );
      await enableOrgs();
      const userToken = await signUp();
      const orgs: string[] = [];
      for (let i = 0; i < 8; i++) orgs.push(await createOrg(userToken));

      const results = await Promise.all(orgs.map((organizationId) => subscribe(userToken, { organizationId })));
      const codes = results.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 201)).toHaveLength(1);
      // Every loser is told why. Without the lock a loser would instead block
      // on the subscription row, lose that race quietly, and answer 200.
      const refused = results.filter((r) => r.statusCode === 409);
      expect(refused).toHaveLength(7);
      for (const r of refused) {
        expect((r.json().error as { code: string }).code).toBe('BILLING_FREE_TIER_ALREADY_CLAIMED');
      }
      expect(await purchaseRows()).toHaveLength(1);
      expect(await prisma.freeTierClaim.count({ where: { applicationId: appId } })).toBe(1);
    });
  });
});
