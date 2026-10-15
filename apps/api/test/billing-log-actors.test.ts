/**
 * `include=actors` on the billing log reads: who the end users and operators
 * a page names are, what an erased or deleted one reads as, who may be told,
 * and what the lookup costs. Asserted on HTTP responses.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BillingLogPageSchema, type BillingLogPage } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { recordBillingEvent, type BillingEventInput } from '../src/modules/billing-log/index.js';
import { UNRESTRICTED, type Scope } from '../src/lib/operator-scopes.js';
import { allOperatorTools } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import type { OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';
import { countQueries } from './query-counter.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

let serial = 0;

interface Cast {
  w: OperatorWorld;
  ownerId: string;
  memberId: string;
}

describe('billing log with its actors resolved', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function cast(): Promise<Cast> {
    const w = await operatorWorld(app);
    const application = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
    const owner = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: application.tenantId, role: 'OWNER' } });
    const member = await prisma.tenantMembership.findUniqueOrThrow({ where: { id: w.membershipId } });
    await prisma.tenantUser.update({ where: { id: owner.tenantUserId }, data: { name: 'Olga Owner' } });
    return { w, ownerId: owner.tenantUserId, memberId: member.tenantUserId };
  }

  async function endUser(applicationId: string): Promise<{ id: string; email: string }> {
    serial += 1;
    const email = `buyer-${serial}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const row = await prisma.endUser.create({ data: { applicationId, email, passwordHash: 'x' } });
    return { id: row.id, email };
  }

  /** A payment recorded for an end user, by the provider. */
  function paid(applicationId: string, endUserId: string, over: Partial<BillingEventInput> = {}): BillingEventInput {
    serial += 1;
    return {
      type: 'payment.recorded',
      applicationId,
      actor: { type: 'provider', id: 'stripe' },
      endUserId,
      subscriptionId: 'sub_1',
      paymentId: `pay_${serial}`,
      provider: 'stripe',
      currency: 'USD',
      amount: 1900,
      data: { priceCharged: null, discountAmount: 0, providerPaymentId: `pi_${serial}`, verification: 'verified' },
      ...over,
    } as BillingEventInput;
  }

  /** A setting an operator changed. */
  function changedBy(applicationId: string, operatorId: string): BillingEventInput {
    return {
      type: 'settings.reporting_currency_changed',
      applicationId,
      actor: { type: 'operator', id: operatorId },
      data: { before: 'USD', after: 'EUR' },
    } as BillingEventInput;
  }

  /** A checkout an end user opened themselves: they are the actor. */
  function refusedFor(applicationId: string, endUserId: string): BillingEventInput {
    return {
      type: 'coupon.refused',
      applicationId,
      actor: { type: 'end_user', id: endUserId },
      data: { code: 'launch', planSlug: 'pro', reasonCode: 'COUPON_EXPIRED', chargedCurrency: 'USD' },
    } as BillingEventInput;
  }

  async function seed(events: BillingEventInput[]): Promise<void> {
    for (const event of events) await recordBillingEvent(prisma, event);
  }

  const get = (w: OperatorWorld, path: string, token = w.ownerToken) =>
    w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}${path}`, headers: bearer(token) });

  async function page(w: OperatorWorld, path: string, token = w.ownerToken): Promise<BillingLogPage> {
    const res = await get(w, path, token);
    expect(res.statusCode, res.body).toBe(200);
    // Strict: a field the schema does not declare fails here.
    return BillingLogPageSchema.parse(res.json().data);
  }

  it('names each end user and operator of the page once, on the log and on all three trails', async () => {
    const { w, ownerId } = await cast();
    const [ada, ben] = [await endUser(w.appId), await endUser(w.appId)];
    await seed([
      paid(w.appId, ada.id, { paymentId: 'pay_ada' }),
      paid(w.appId, ada.id),
      refusedFor(w.appId, ben.id),
      changedBy(w.appId, ownerId),
      changedBy(w.appId, ownerId),
    ]);

    const whole = await page(w, '/billing/events?include=actors');
    expect(whole.items).toHaveLength(5);
    expect(whole.actors!.endUsers).toEqual(
      expect.arrayContaining([
        { id: ada.id, state: 'known', email: ada.email },
        { id: ben.id, state: 'known', email: ben.email },
      ]),
    );
    expect(whole.actors!.endUsers).toHaveLength(2);
    expect(whole.actors!.operators).toEqual([
      { id: ownerId, state: 'known', name: 'Olga Owner', email: expect.stringMatching(/^owner-.*@example\.com$/) as string },
    ]);

    // Only the people of the page returned, not of the whole log.
    const newest = await page(w, '/billing/events?include=actors&limit=2');
    expect(newest.actors).toMatchObject({ endUsers: [], operators: [{ id: ownerId }] });

    for (const path of [`/end-users/${ada.id}/billing-events`, '/billing/subscriptions/sub_1/events', '/billing/payments/pay_ada/events']) {
      const trail = await page(w, `${path}?include=actors`);
      expect(trail.actors, path).toEqual({ endUsers: [{ id: ada.id, state: 'known', email: ada.email }], operators: [] });
    }
  });

  it('shows an erased end user as erased with no email, a deleted one as unknown, and never one of another Application', async () => {
    const { w } = await cast();
    const other = await operatorWorld(app);
    const [erased, deleted, kept, foreign] = [
      await endUser(w.appId),
      await endUser(w.appId),
      await endUser(w.appId),
      await endUser(other.appId),
    ];
    await seed([paid(w.appId, erased.id), paid(w.appId, deleted.id), paid(w.appId, kept.id), paid(w.appId, foreign.id)]);

    const erasure = await w.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${w.appId}/end-users/${erased.id}?erasure=true`,
      headers: bearer(w.ownerToken),
    });
    expect(erasure.statusCode, erasure.body).toBe(200);
    await prisma.endUser.delete({ where: { id: deleted.id } });

    const res = await get(w, '/billing/events?include=actors');
    const { actors } = BillingLogPageSchema.parse(res.json().data);
    const byId = new Map(actors!.endUsers!.map((user) => [user.id, user]));
    expect(byId.get(erased.id)).toEqual({ id: erased.id, state: 'erased', email: null });
    expect(byId.get(deleted.id)).toEqual({ id: deleted.id, state: 'unknown', email: null });
    expect(byId.get(kept.id)).toEqual({ id: kept.id, state: 'known', email: kept.email });
    expect(byId.get(foreign.id)).toEqual({ id: foreign.id, state: 'unknown', email: null });
    expect(res.body).not.toContain(erased.email);
    expect(res.body).not.toContain(foreign.email);
    // The placeholder address an erased row keeps is not an email to show either.
    expect(res.body).not.toContain('deleted.invalid');
  });

  it('still names an operator who has left the workspace, and reads a deleted account as unknown', async () => {
    const { w, ownerId, memberId } = await cast();
    await seed([changedBy(w.appId, memberId), changedBy(w.appId, ownerId)]);

    await prisma.tenantMembership.delete({ where: { id: w.membershipId } });
    const left = (await page(w, '/billing/events?include=actors')).actors!.operators;
    expect(left.find((operator) => operator.id === memberId)).toEqual({
      id: memberId,
      state: 'known',
      name: null,
      email: expect.stringMatching(/^member-.*@example\.com$/) as string,
    });

    await prisma.tenantUser.delete({ where: { id: memberId } });
    const gone = (await page(w, '/billing/events?include=actors')).actors!.operators;
    expect(gone.find((operator) => operator.id === memberId)).toEqual({ id: memberId, state: 'unknown', name: null, email: null });
    expect(gone.find((operator) => operator.id === ownerId)).toMatchObject({ state: 'known', name: 'Olga Owner' });
  });

  it('resolves no end user for a caller who may not read end users, and still names operators', async () => {
    const { w, ownerId } = await cast();
    const buyer = await endUser(w.appId);
    await seed([paid(w.appId, buyer.id), refusedFor(w.appId, buyer.id), changedBy(w.appId, ownerId)]);

    await w.setScopes(['billing:read']);
    const res = await get(w, '/billing/events?include=actors', w.memberToken);
    expect(res.statusCode, res.body).toBe(200);
    const narrow = BillingLogPageSchema.parse(res.json().data);
    expect(narrow.actors!.endUsers).toBeNull();
    expect(narrow.actors!.operators).toMatchObject([{ id: ownerId, state: 'known' }]);
    expect(res.body).not.toContain(buyer.email);
    // The ids stay: they are the log's own.
    expect(narrow.items.some((entry) => entry.endUserId === buyer.id)).toBe(true);
    const trail = await get(w, `/end-users/${buyer.id}/billing-events?include=actors`, w.memberToken);
    expect(trail.body).not.toContain(buyer.email);

    await w.setScopes(['billing:read', 'end-users:read']);
    const wide = await page(w, '/billing/events?include=actors', w.memberToken);
    expect(wide.actors!.endUsers).toEqual([{ id: buyer.id, state: 'known', email: buyer.email }]);
  });

  it('costs one query for end users and one for operators, for a page of one as for a page of many', async () => {
    const small = await cast();
    const large = await cast();
    await seed([paid(small.w.appId, (await endUser(small.w.appId)).id), changedBy(small.w.appId, small.ownerId)]);
    const buyers = await Promise.all(Array.from({ length: 12 }, () => endUser(large.w.appId)));
    await seed([
      ...buyers.flatMap((buyer) => [paid(large.w.appId, buyer.id), refusedFor(large.w.appId, buyer.id)]),
      changedBy(large.w.appId, large.ownerId),
      changedBy(large.w.appId, large.memberId),
    ]);

    const plainSmall = await countQueries(() => get(small.w, '/billing/events'));
    const withSmall = await countQueries(() => get(small.w, '/billing/events?include=actors'));
    const plainLarge = await countQueries(() => get(large.w, '/billing/events'));
    const withLarge = await countQueries(() => get(large.w, '/billing/events?include=actors'));

    const resolved = (await page(large.w, '/billing/events?include=actors')).actors!;
    expect(resolved.endUsers).toHaveLength(12);
    expect(resolved.operators).toHaveLength(2);
    expect(plainLarge.count, plainLarge.queries.join('\n')).toBe(plainSmall.count);
    expect(withSmall.count - plainSmall.count, withSmall.queries.join('\n')).toBe(2);
    expect(withLarge.count - plainLarge.count, withLarge.queries.join('\n')).toBe(2);
  });

  describe('the operator MCP tool', () => {
    const tool = allOperatorTools.find((t) => t.name === 'recent_billing_events')!;
    interface ToolPage {
      events: BillingLogPage['items'];
      nextCursor: string | null;
      actors: BillingLogPage['actors'];
    }

    async function ctxFor(c: Cast, scopes: ReadonlySet<Scope>, who: 'owner' | 'member'): Promise<OperatorToolContext> {
      const application = await prisma.application.findUniqueOrThrow({ where: { id: c.w.appId } });
      const base = { tenantId: application.tenantId, scopes, canWrite: false, canAdmin: false };
      if (who === 'member') return { ...base, tenantUserId: c.memberId, role: 'MEMBER', tenantMembershipId: c.w.membershipId };
      const owner = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: application.tenantId, role: 'OWNER' } });
      return { ...base, tenantUserId: c.ownerId, role: 'OWNER', tenantMembershipId: owner.id };
    }

    it('resolves actors when asked, and no end user for a member without end-users:read', async () => {
      const c = await cast();
      const buyer = await endUser(c.w.appId);
      await seed([paid(c.w.appId, buyer.id), changedBy(c.w.appId, c.ownerId)]);

      const plain = (await tool.handler(await ctxFor(c, UNRESTRICTED, 'owner'), { applicationId: c.w.appId })) as ToolPage;
      expect(plain.actors).toBeNull();

      const asked = (await tool.handler(await ctxFor(c, UNRESTRICTED, 'owner'), { applicationId: c.w.appId, include: 'actors' })) as ToolPage;
      expect(BillingLogPageSchema.parse({ items: asked.events, nextCursor: asked.nextCursor, actors: asked.actors }).actors).toEqual({
        endUsers: [{ id: buyer.id, state: 'known', email: buyer.email }],
        operators: [{ id: c.ownerId, state: 'known', name: 'Olga Owner', email: expect.any(String) as string }],
      });

      const billingOnly = new Set<Scope>(['billing:read']);
      const narrow = (await tool.handler(await ctxFor(c, billingOnly, 'member'), { applicationId: c.w.appId, include: 'actors' })) as ToolPage;
      expect(narrow.actors).toMatchObject({ endUsers: null, operators: [{ id: c.ownerId }] });
      expect(JSON.stringify(narrow)).not.toContain(buyer.email);

      await expect(tool.handler(await ctxFor(c, UNRESTRICTED, 'owner'), { applicationId: c.w.appId, include: 'emails' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });
  });
});
