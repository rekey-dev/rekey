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
