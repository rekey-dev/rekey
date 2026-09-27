/**
 * What an end-user sees of their own subscriptions.
 *
 * Two findings from a live e2e run:
 *
 *  1. `GET /billing/subscription` returned the row's raw `metadata`, reachable
 *     with the publishable key. It carried the operator's private grant note
 *     ("INTERNAL: comped, churn risk"), `previousProvider`, retired checkout
 *     sessions and the external event id that activated it. Every end-user
 *     subscription response is now an explicit allowlist, down to the two
 *     metadata keys that describe the buyer's own checkout.
 *
 *  2. A buyer holding two live subscriptions (pro and basic) saw only one, and
 *     the portal offered to "Switch" them to the plan they already paid for.
 *     `GET /billing/subscriptions` lists them all; the singular read picks one
 *     by a documented rule; cancel can name which one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const PASSWORD = 'pw-one-two-three';
const NOTE = 'INTERNAL: comped, churn risk, do not tell customer';

/** The fields an end-user subscription response may carry, and no others. */
const SELF_SUBSCRIPTION_KEYS = [
  'applicationId',
  'beneficiaryOrgId',
  'canceledAt',
  'cancelAt',
  'createdAt',
  'currentPeriodEnd',
  'endUserId',
  'id',
  'metadata',
  'planId',
  'provider',
  'providerCapabilities',
  'providerSubId',
  'status',
  'trialEndsAt',
  'updatedAt',
];

describe('the end-user view of their own subscriptions', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let pubKey: string;
  let userToken: string;
  let endUserId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });
  const self = (): Record<string, string> => ({ authorization: `Bearer ${pubKey}`, 'x-rekey-user-token': userToken });

  beforeEach(async () => {
    const slug = `ss${Math.random().toString(36).slice(2, 7)}`;
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
      payload: { name: 'SS', slug, enableBilling: true },
    });
    appId = (created.json().data as { id: string }).id;
    pubKey = (await prisma.application.findUniqueOrThrow({ where: { id: appId } })).publicKey;
    for (const [plan, amount] of [
      ['basic', 1000],
      ['pro', 2000],
      ['free', 0],
    ] as const) {
      const r = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/plans`,
        headers: auth(),
        payload: { slug: plan, name: plan, amount, kind: 'SUBSCRIPTION' },
      });
      if (r.statusCode !== 201) throw new Error(`plan ${r.statusCode}: ${r.body}`);
    }
    const su = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${pubKey}` },
      payload: { email: `buyer-${slug}@example.com`, password: PASSWORD },
    });
    userToken = (su.json().data as { accessToken: string }).accessToken;
    endUserId = (await prisma.endUser.findFirstOrThrow({ where: { applicationId: appId } })).id;
  });

  async function grant(planSlug: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users/${endUserId}/subscriptions`,
      headers: auth(),
      payload: { planSlug, note: NOTE },
    });
    if (r.statusCode !== 201) throw new Error(`grant ${r.statusCode}: ${r.body}`);
    const id = (r.json().data as { subscription?: { id: string }; id?: string }).subscription?.id;
    return id ?? (r.json().data as { id: string }).id;
  }

  /** Make the stored metadata carry everything the e2e run saw leak. */
  async function dirtyMetadata(subscriptionId: string): Promise<void> {
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        metadata: {
          ...(row.metadata as Record<string, unknown>),
          previousProvider: 'stripe',
          retiredCheckoutSessions: ['cs_retired_1'],
          activation: 'Activated by external event evt_secret_123',
        },
      },
    });
  }

  function expectAllowlisted(sub: unknown, raw: string): void {
    expect(Object.keys(sub as object).sort()).toEqual(
      SELF_SUBSCRIPTION_KEYS.filter((k) => k in (sub as object)).sort(),
    );
    for (const key of Object.keys((sub as { metadata: object }).metadata)) {
      expect(['checkoutSessionId', 'oneTime']).toContain(key);
    }
    for (const secret of [NOTE, 'previousProvider', 'cs_retired_1', 'evt_secret_123']) {
      expect(raw).not.toContain(secret);
    }
  }

  const get = (url: string): Promise<LightMyRequestResponse> => app.inject({ method: 'GET', url, headers: self() });

  describe('no raw metadata on any end-user subscription response', () => {
    it('GET /billing/subscription', async () => {
      await dirtyMetadata(await grant('basic'));
      const res = await get('/api/v1/billing/subscription');
      expect(res.statusCode).toBe(200);
      expectAllowlisted(res.json().data, res.body);
    });

    it('GET /auth/me and /users/me with include=subscription', async () => {
      await dirtyMetadata(await grant('basic'));
      for (const url of ['/api/v1/auth/me?include=subscription', '/api/v1/users/me?include=subscription']) {
        const res = await get(url);
        expect(res.statusCode).toBe(200);
        expectAllowlisted((res.json().data as { subscription: unknown }).subscription, res.body);
      }
    });

    it('POST /billing/subscription/cancel', async () => {
      await dirtyMetadata(await grant('basic'));
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/subscription/cancel',
        headers: self(),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expectAllowlisted(res.json().data, res.body);
    });

    it('POST /billing/subscribe', async () => {
      const row = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
      await prisma.application.update({
        where: { id: appId },
        data: { billingConfig: { ...(row.billingConfig as object), defaultPlanSlug: 'free' } },
      });
      const res = await app.inject({ method: 'POST', url: '/api/v1/billing/subscribe', headers: self(), payload: {} });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.metadata).toEqual({});
      expect(res.body).not.toContain('self-serve free tier');
    });

    it('GET /billing/subscriptions', async () => {
      await dirtyMetadata(await grant('basic'));
      const res = await get('/api/v1/billing/subscriptions');
      expect(res.statusCode).toBe(200);
      const items = (res.json().data as { items: unknown[] }).items;
      expect(items).toHaveLength(1);
      expectAllowlisted(items[0], res.body);
    });
  });

  describe('a buyer holding two live subscriptions', () => {
    it('lists both, and the singular read picks the newest paid one', async () => {
      const basic = await grant('basic');
      const pro = await grant('pro');
      await grant('free');

      const list = await get('/api/v1/billing/subscriptions');
      expect(list.statusCode).toBe(200);
      const items = (list.json().data as { items: Array<{ id: string }> }).items;
      expect(items.map((s) => s.id).slice(0, 2)).toEqual([pro, basic]);
      expect(items).toHaveLength(3);

      const one = await get('/api/v1/billing/subscription');
      expect((one.json().data as { id: string }).id).toBe(pro);
    });

    it('breaks a createdAt tie by id, so the answer never flips between reads', async () => {
      const basic = await grant('basic');
      const pro = await grant('pro');
      const at = new Date('2026-01-01T00:00:00Z');
      await prisma.subscription.updateMany({ where: { id: { in: [basic, pro] } }, data: { createdAt: at } });
      const expected = [basic, pro].sort().reverse()[0];
      for (let i = 0; i < 5; i++) {
        expect(((await get('/api/v1/billing/subscription')).json().data as { id: string }).id).toBe(expected);
      }
      const items = ((await get('/api/v1/billing/subscriptions')).json().data as { items: Array<{ id: string }> }).items;
      expect(items[0]!.id).toBe(expected);
    });

    it('can cancel the one it names, leaving the other live', async () => {
      const basic = await grant('basic');
      const pro = await grant('pro');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/subscription/cancel',
        headers: self(),
        payload: { subscriptionId: basic, atPeriodEnd: false },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json().data as { id: string }).id).toBe(basic);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: basic } })).status).toBe('CANCELED');
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: pro } })).status).toBe('ACTIVE');
    });

    it('ranks a priced default plan as paid, not as the free fallback', async () => {
      await grant('basic');
      const pro = await grant('pro');
      const row = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
      // Stored past the write guard, as a row nominated before it would be.
      await prisma.application.update({
        where: { id: appId },
        data: { billingConfig: { ...(row.billingConfig as object), defaultPlanSlug: 'pro' } },
      });
      expect(((await get('/api/v1/billing/subscription')).json().data as { id: string }).id).toBe(pro);
    });

    it('caps the list at 100 rows', async () => {
      const planIds: string[] = [];
      for (let i = 0; i < 101; i++) {
        const plan = await prisma.plan.create({
          data: { applicationId: appId, slug: `bulk-${i}`, name: `Bulk ${i}`, amount: 100 },
        });
        planIds.push(plan.id);
      }
      await prisma.subscription.createMany({
        data: planIds.map((planId) => ({ applicationId: appId, endUserId, planId, status: 'ACTIVE' as const })),
      });
      const items = ((await get('/api/v1/billing/subscriptions')).json().data as { items: unknown[] }).items;
      expect(items).toHaveLength(100);
    });

    it('refuses to cancel an unfinished checkout by id', async () => {
      await grant('basic');
      const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'pro' } });
      const pending = await prisma.subscription.create({
        data: { applicationId: appId, endUserId, planId: plan.id, status: 'PENDING', provider: 'stripe' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/subscription/cancel',
        headers: self(),
        payload: { subscriptionId: pending.id },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SUBSCRIPTION_CHECKOUT_UNFINISHED');
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('PENDING');
    });

    it('a subscription from another Application answers 404', async () => {
      const other = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'Other', slug: `o${Math.random().toString(36).slice(2, 7)}`, enableBilling: true },
      });
      const otherAppId = (other.json().data as { id: string }).id;
      const plan = await prisma.plan.create({
        data: { applicationId: otherAppId, slug: 'x', name: 'x', amount: 100 },
      });
      const foreignUser = await prisma.endUser.create({
        data: { applicationId: otherAppId, email: `f-${Math.random().toString(36).slice(2, 7)}@example.com` },
      });
      const foreign = await prisma.subscription.create({
        data: { applicationId: otherAppId, endUserId: foreignUser.id, planId: plan.id, status: 'ACTIVE' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/subscription/cancel',
        headers: self(),
        payload: { subscriptionId: foreign.id },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('SUBSCRIPTION_NOT_FOUND');
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe('ACTIVE');
    });

    describe('an organization subscription', () => {
      async function orgWithSubscription(): Promise<{ orgId: string; subId: string }> {
        const org = await prisma.organization.create({
          data: { applicationId: appId, name: 'Team', slug: `t${Math.random().toString(36).slice(2, 7)}` },
        });
        await prisma.organizationMembership.create({
          data: { organizationId: org.id, endUserId, role: 'OWNER' },
        });
        const orgId = org.id;
        const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'pro' } });
        const sub = await prisma.subscription.create({
          data: { applicationId: appId, endUserId, beneficiaryOrgId: orgId, planId: plan.id, status: 'ACTIVE' },
        });
        return { orgId, subId: sub.id };
      }

      it('its id without organizationId answers 404', async () => {
        const { subId } = await orgWithSubscription();
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/billing/subscription/cancel',
          headers: self(),
          payload: { subscriptionId: subId },
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('SUBSCRIPTION_NOT_FOUND');
        expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).status).toBe('ACTIVE');
      });

      it('a MEMBER who is not OWNER or ADMIN gets 403', async () => {
        const { orgId, subId } = await orgWithSubscription();
        const su = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${pubKey}` },
          payload: { email: `member-${Math.random().toString(36).slice(2, 7)}@example.com`, password: PASSWORD },
        });
        const memberToken = (su.json().data as { accessToken: string }).accessToken;
        const member = await prisma.endUser.findFirstOrThrow({
          where: { applicationId: appId, email: { startsWith: 'member-' } },
        });
        await prisma.organizationMembership.create({
          data: { organizationId: orgId, endUserId: member.id, role: 'MEMBER' },
        });
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/billing/subscription/cancel',
          headers: { authorization: `Bearer ${pubKey}`, 'x-rekey-user-token': memberToken },
          payload: { subscriptionId: subId, organizationId: orgId },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('ORGANIZATION_ROLE_INSUFFICIENT');
        expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).status).toBe('ACTIVE');
      });
    });

    it('refuses to cancel a subscription that is not the caller', async () => {
      await grant('basic');
      const other = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${pubKey}` },
        payload: { email: `other-${Math.random().toString(36).slice(2, 7)}@example.com`, password: PASSWORD },
      });
      const otherToken = (other.json().data as { accessToken: string }).accessToken;
      const mine = (await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } })).id;
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/subscription/cancel',
        headers: { authorization: `Bearer ${pubKey}`, 'x-rekey-user-token': otherToken },
        payload: { subscriptionId: mine },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('SUBSCRIPTION_NOT_FOUND');
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: mine } })).status).toBe('ACTIVE');
    });
  });
});
