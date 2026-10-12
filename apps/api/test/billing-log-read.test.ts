/**
 * The billing log's read side: the operator routes, their paging and filters,
 * who may read them, and the query count behind a page.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BillingLogPageSchema, PriceFallbackSummarySchema, type BillingLogEntry } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { readBillingLog, recordBillingEvent, type BillingEventInput } from '../src/modules/billing-log/index.js';
import { UNRESTRICTED } from '../src/lib/operator-scopes.js';
import { TOOL_SCOPES, allOperatorTools } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import type { OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { billingEventsForExport } from '../src/modules/billing-log/index.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';
import { countQueries } from './query-counter.js';

let serial = 0;

/** A permanent event with a subscription, a payment, an end user and a currency of the caller's choosing. */
function paymentRecorded(applicationId: string, over: Partial<BillingEventInput> = {}): BillingEventInput {
  serial += 1;
  return {
    type: 'payment.recorded',
    applicationId,
    actor: { type: 'provider', id: 'stripe' },
    endUserId: 'eu_1',
    subscriptionId: 'sub_1',
    paymentId: `pay_${serial}`,
    provider: 'stripe',
    currency: 'USD',
    amount: 1900,
    data: {
      priceCharged: { planPriceId: 'pp_1', currency: 'USD', amount: 1900 },
      discountAmount: 0,
      providerPaymentId: `pi_${serial}`,
      verification: 'verified',
    },
    ...over,
  } as BillingEventInput;
}

function priceFallback(applicationId: string, over: Partial<BillingEventInput> = {}): BillingEventInput {
  return {
    type: 'checkout.price_fallback',
    applicationId,
    actor: { type: 'end_user', id: 'eu_2' },
    endUserId: 'eu_2',
    currency: 'USD',
    amount: 2000,
    data: {
      planSlug: 'pro',
      requested: { planPriceId: 'pp_inr', currency: 'INR', amount: 149900 },
      charged: { planPriceId: 'pp_usd', currency: 'USD', amount: 2000 },
      reason: 'no_provider_for_currency',
      buyerCountry: 'IN',
      buyerCountrySource: 'vouched',
    },
    ...over,
  } as BillingEventInput;
}

async function seed(events: BillingEventInput[]): Promise<void> {
  for (const event of events) await recordBillingEvent(prisma, event);
}

describe('billing log read side', () => {
  let app: FastifyInstance;
  let world: OperatorWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const read = (w: OperatorWorld, path: string, token = w.ownerToken) =>
    w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}${path}`, headers: bearer(token) });

  async function page(w: OperatorWorld, path: string): Promise<{ items: BillingLogEntry[]; nextCursor: string | null }> {
    const res = await read(w, path);
    expect(res.statusCode, res.body).toBe(200);
    // Strict: a field the schema does not declare fails here.
    return BillingLogPageSchema.parse(res.json().data);
  }

  describe('paging', () => {
    it('walks the whole log newest first on the cursor, and an event written mid-walk neither repeats nor displaces an entry', async () => {
      world = await operatorWorld(app);
      await seed(Array.from({ length: 25 }, () => paymentRecorded(world.appId)));

      const first = await page(world, '/billing/events?limit=10');
      expect(first.items).toHaveLength(10);
      expect(first.nextCursor).toBe(first.items[9]!.seq);

      // Written after the first page was read: an offset would shift every later page by five.
      await seed(Array.from({ length: 5 }, () => paymentRecorded(world.appId)));

      const second = await page(world, `/billing/events?limit=10&cursor=${first.nextCursor}`);
      const third = await page(world, `/billing/events?limit=10&cursor=${second.nextCursor}`);
      expect(third.items).toHaveLength(5);
      expect(third.nextCursor).toBeNull();

      const walked = [...first.items, ...second.items, ...third.items];
      const seqs = walked.map((entry) => BigInt(entry.seq));
      expect(new Set(seqs).size).toBe(25);
      expect([...seqs].sort((a, b) => (a < b ? 1 : -1))).toEqual(seqs);
      const original = await prisma.billingEvent.findMany({ where: { applicationId: world.appId }, orderBy: { seq: 'asc' }, take: 25 });
      expect(new Set(walked.map((entry) => entry.id))).toEqual(new Set(original.map((row) => row.id)));
    });

    it('ends a log that fills its last page exactly with a null cursor', async () => {
      world = await operatorWorld(app);
      await seed(Array.from({ length: 4 }, () => paymentRecorded(world.appId)));
      const exact = await page(world, '/billing/events?limit=4');
      expect(exact.items).toHaveLength(4);
      expect(exact.nextCursor).toBeNull();
    });

    it('carries seq as a string, the actor in lower case, and no dedupe key', async () => {
      world = await operatorWorld(app);
      await seed([paymentRecorded(world.appId, { dedupeKey: 'internal-key' })]);
      const res = await read(world, '/billing/events');
      const [entry] = (res.json().data as { items: Array<Record<string, unknown>> }).items;
      expect(typeof entry!.seq).toBe('string');
      expect(entry!.actor).toEqual({ type: 'provider', id: 'stripe' });
      expect(entry).not.toHaveProperty('dedupeKey');
      expect(res.body).not.toContain('internal-key');
    });

    it('refuses a limit above the maximum, a cursor that is not a number, and a parameter it does not know', async () => {
      world = await operatorWorld(app);
      for (const query of ['limit=201', 'limit=0', 'cursor=abc', 'cursor=-1', 'offset=10', 'type=payment.invented', 'from=yesterday']) {
        const res = await read(world, `/billing/events?${query}`);
        expect(res.statusCode, `${query}: ${res.body}`).toBe(400);
      }
    });
  });

  describe('filters', () => {
    it('narrows by type, tier, end user, subscription, payment, currency and time', async () => {
      world = await operatorWorld(app);
      const id = world.appId;
      await seed([
        paymentRecorded(id, { paymentId: 'pay_a', subscriptionId: 'sub_a', endUserId: 'eu_a', occurredAt: new Date('2026-09-01T00:00:00Z') }),
        paymentRecorded(id, { paymentId: 'pay_b', subscriptionId: 'sub_b', endUserId: 'eu_b', currency: 'INR', occurredAt: new Date('2026-09-10T00:00:00Z') }),
        priceFallback(id, { occurredAt: new Date('2026-09-20T00:00:00Z') }),
        {
          type: 'checkout.refused',
          applicationId: id,
          actor: { type: 'end_user', id: 'eu_a' },
          endUserId: 'eu_a',
          occurredAt: new Date('2026-09-25T00:00:00Z'),
          data: { planSlug: 'pro', code: 'BILLING_CURRENCY_CONFLICT', requestedCurrency: 'INR', buyerCountry: 'IN', buyerCountrySource: 'hint' },
        },
      ]);
      const types = async (query: string): Promise<string[]> => (await page(world, `/billing/events?${query}`)).items.map((e) => e.type);

      expect(await types('type=checkout.price_fallback')).toEqual(['checkout.price_fallback']);
      expect(await types('type=checkout.price_fallback,checkout.refused')).toEqual(['checkout.refused', 'checkout.price_fallback']);
      expect(await types('tier=DIAGNOSTIC')).toEqual(['checkout.refused']);
      expect(await types('tier=PERMANENT')).toEqual(['checkout.price_fallback', 'payment.recorded', 'payment.recorded']);
      expect(await types('endUserId=eu_a')).toEqual(['checkout.refused', 'payment.recorded']);
      expect(await types('subscriptionId=sub_b')).toEqual(['payment.recorded']);
      expect(await types('paymentId=pay_a')).toEqual(['payment.recorded']);
      // Any case in, upper case matched.
      expect(await types('currency=inr')).toEqual(['payment.recorded']);
      expect(await types('from=2026-09-10T00:00:00.000Z&to=2026-09-20T00:00:00.000Z')).toEqual(['payment.recorded']);
      expect(await types('endUserId=eu_a&type=payment.recorded&currency=USD')).toEqual(['payment.recorded']);
    });

    it('serves the trail of one subscription, one payment and one end user', async () => {
      world = await operatorWorld(app);
      const id = world.appId;
      await seed([
        paymentRecorded(id, { paymentId: 'pay_a', subscriptionId: 'sub_a', endUserId: 'eu_a' }),
        paymentRecorded(id, { paymentId: 'pay_b', subscriptionId: 'sub_a', endUserId: 'eu_b' }),
        paymentRecorded(id, { paymentId: 'pay_c', subscriptionId: 'sub_c', endUserId: 'eu_a' }),
      ]);
      const payments = async (path: string): Promise<Array<string | null>> => (await page(world, path)).items.map((e) => e.paymentId);

      expect(await payments('/billing/subscriptions/sub_a/events')).toEqual(['pay_b', 'pay_a']);
      expect(await payments('/billing/payments/pay_c/events')).toEqual(['pay_c']);
      expect(await payments('/end-users/eu_a/billing-events')).toEqual(['pay_c', 'pay_a']);
      expect(await payments('/billing/subscriptions/sub_a/events?limit=1')).toEqual(['pay_b']);
      // The path decides the entity: a query cannot move the trail to another one.
      expect(await payments('/billing/subscriptions/sub_a/events?subscriptionId=sub_c')).toEqual(['pay_b', 'pay_a']);
    });
  });

  describe('who may read it', () => {
    it("does not let an operator of one workspace read another workspace's log, by id or by filter", async () => {
      const mine = await operatorWorld(app);
      const theirs = await operatorWorld(app);
      await seed([paymentRecorded(theirs.appId, { subscriptionId: 'sub_theirs', paymentId: 'pay_theirs', endUserId: 'eu_theirs' })]);
      await seed([paymentRecorded(mine.appId)]);

      // Guessing the other workspace's Application id.
      for (const path of [
        '/billing/events',
        '/billing/subscriptions/sub_theirs/events',
        '/billing/payments/pay_theirs/events',
        '/end-users/eu_theirs/billing-events',
        '/billing/reconciliation',
        '/billing/price-fallbacks',
      ]) {
        const res = await mine.inject({
          method: 'GET',
          url: `/api/v1/tenant/applications/${theirs.appId}${path}`,
          headers: bearer(mine.ownerToken),
        });
        expect(res.statusCode, `${path}: ${res.body}`).toBe(404);
        expect(res.json().error.code).toBe('APPLICATION_NOT_FOUND');
        expect(res.body).not.toContain('pay_theirs');
      }

      // Guessing the other workspace's entity ids inside my own Application.
      for (const path of [
        '/billing/events?subscriptionId=sub_theirs',
        '/billing/events?paymentId=pay_theirs',
        '/billing/events?endUserId=eu_theirs',
        '/billing/subscriptions/sub_theirs/events',
        '/billing/payments/pay_theirs/events',
        '/end-users/eu_theirs/billing-events',
      ]) {
        expect((await page(mine, path)).items, path).toEqual([]);
      }
      const own = await page(mine, '/billing/events');
      expect(own.items.map((e) => e.applicationId)).toEqual([mine.appId]);
    });

    it('follows per-application grants and the billing:read scope', async () => {
      const w = await operatorWorld(app, 'APP_VIEWER');
      await seed([paymentRecorded(w.appId)]);
      expect((await read(w, '/billing/events', w.memberToken)).statusCode).toBe(200);

      // A member with a grant on another Application only.
      const other = await w.inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: bearer(w.ownerToken),
        payload: { name: 'Other', slug: `other-${Date.now()}` },
      });
      const otherId = (other.json().data as { id: string }).id;
      const ungranted = await w.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${otherId}/billing/events`,
        headers: bearer(w.memberToken),
      });
      expect(ungranted.statusCode, ungranted.body).toBe(404);

      await w.setScopes(['overview:read']);
      const unscoped = await read(w, '/billing/events', w.memberToken);
      expect(unscoped.statusCode, unscoped.body).toBe(403);
      await w.setScopes(['overview:read', 'billing:read']);
      expect((await read(w, '/billing/events', w.memberToken)).statusCode).toBe(200);
    });

    it('is not reachable with an API key or with no credential', async () => {
      const w = await operatorWorld(app);
      const application = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
      for (const headers of [{}, bearer(w.secretKey), bearer(application.publicKey)]) {
        const res = await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/billing/events`, headers });
        expect(res.statusCode, res.body).toBe(401);
      }
    });
  });

  describe('cost', () => {
    it('reads a page in one query however many events the Application holds', async () => {
      world = await operatorWorld(app);
      await seed(Array.from({ length: 3 }, () => paymentRecorded(world.appId)));
      const small = await countQueries(() => readBillingLog({ applicationId: world.appId, limit: 50 }));
      const smallRoute = await countQueries(() => read(world, '/billing/events?limit=50'));

      await prisma.billingEvent.createMany({
        data: Array.from({ length: 600 }, (_, i) => ({
          applicationId: world.appId,
          type: 'payment.recorded',
          tier: 'PERMANENT' as const,
          occurredAt: new Date(),
          dedupeKey: `bulk-${i}`,
          actorType: 'PROVIDER' as const,
          subscriptionId: `sub_${i % 7}`,
          paymentId: `pay_bulk_${i}`,
          currency: 'USD',
          amount: 1900,
          data: { priceCharged: null, discountAmount: 0, providerPaymentId: null, verification: 'verified' },
        })),
      });
      const large = await countQueries(() => readBillingLog({ applicationId: world.appId, limit: 50 }));
      const largeRoute = await countQueries(() => read(world, '/billing/events?limit=50&subscriptionId=sub_3'));

      expect(small.count).toBe(1);
      expect(large.count).toBe(1);
      expect(largeRoute.count, largeRoute.queries.join('\n')).toBe(smallRoute.count);
    });
  });
  describe('price fallbacks counted', () => {
    it('groups the fallbacks of a period by plan, currency and country, most frequent first, for one Application only', async () => {
      const mine = await operatorWorld(app);
      const theirs = await operatorWorld(app);
      const recent = new Date(Date.now() - 60 * 60 * 1000);
      const inr = (over: Record<string, unknown> = {}, occurredAt = recent) =>
        priceFallback(mine.appId, { occurredAt, data: { ...(priceFallback(mine.appId).data as object), ...over } } as Partial<BillingEventInput>);
      await seed([
        inr(),
        inr(),
        inr(),
        inr({ buyerCountry: null, buyerCountrySource: null }),
        inr({ planSlug: 'team', requested: { planPriceId: 'pp_eur', currency: 'EUR', amount: 900 }, buyerCountry: 'DE' }),
        // Outside the default seven days.
        inr({}, new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)),
        // Not a fallback.
        paymentRecorded(mine.appId),
        priceFallback(theirs.appId, { occurredAt: recent }),
      ]);

      const res = await read(mine, '/billing/price-fallbacks');
      expect(res.statusCode, res.body).toBe(200);
      const summary = PriceFallbackSummarySchema.parse(res.json().data);
      expect(summary.total).toBe(5);
      expect(summary.groups.map((g) => [g.planSlug, g.requestedCurrency, g.chargedCurrency, g.country, g.count])).toEqual([
        ['pro', 'INR', 'USD', 'IN', 3],
        ['pro', 'INR', 'USD', null, 1],
        ['team', 'EUR', 'USD', 'DE', 1],
      ]);

      const wider = PriceFallbackSummarySchema.parse(
        (await read(mine, `/billing/price-fallbacks?from=${new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()}&to=${new Date().toISOString()}`)).json().data,
      );
      expect(wider.groups[0]).toMatchObject({ country: 'IN', count: 4 });

      const tooLong = await read(mine, '/billing/price-fallbacks?from=2026-01-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z');
      expect(tooLong.statusCode).toBe(400);
      expect(tooLong.json().error.code).toBe('BILLING_LOG_PERIOD_INVALID');

      const stranger = await mine.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${theirs.appId}/billing/price-fallbacks`,
        headers: bearer(mine.ownerToken),
      });
      expect(stranger.statusCode, stranger.body).toBe(404);
    });
  });

  describe('the operator MCP tool and the data export', () => {
    const tool = allOperatorTools.find((t) => t.name === 'recent_billing_events')!;

    async function ctxFor(w: OperatorWorld): Promise<OperatorToolContext> {
      const a = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
      const m = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: a.tenantId, role: 'OWNER' } });
      return { tenantUserId: m.tenantUserId, tenantId: a.tenantId, role: 'OWNER', tenantMembershipId: m.id, scopes: UNRESTRICTED, canWrite: false, canAdmin: false };
    }

    it('recent_billing_events reads the same entries under billing:read, pages on the cursor, and is closed to another workspace', async () => {
      const mine = await operatorWorld(app);
      const theirs = await operatorWorld(app);
      await seed([
        paymentRecorded(mine.appId, { paymentId: 'pay_1' }),
        priceFallback(mine.appId),
        paymentRecorded(mine.appId, { paymentId: 'pay_3' }),
      ]);
      await seed([paymentRecorded(theirs.appId, { paymentId: 'pay_theirs' })]);

      expect(TOOL_SCOPES.recent_billing_events).toBe('billing:read');
      expect(tool.write).toBeFalsy();

      const first = (await tool.handler(await ctxFor(mine), { applicationId: mine.appId, limit: 2 })) as {
        events: BillingLogEntry[];
        nextCursor: string | null;
        actors: null;
      };
      expect(BillingLogPageSchema.parse({ items: first.events, nextCursor: first.nextCursor, actors: first.actors }).items.map((e) => e.type)).toEqual([
        'payment.recorded',
        'checkout.price_fallback',
      ]);
      const rest = (await tool.handler(await ctxFor(mine), { applicationId: mine.appId, limit: 2, cursor: first.nextCursor })) as typeof first;
      expect(rest.events.map((e) => e.paymentId)).toEqual(['pay_1']);
      expect(rest.nextCursor).toBeNull();

      const fallbacks = (await tool.handler(await ctxFor(mine), { applicationId: mine.appId, type: 'checkout.price_fallback' })) as typeof first;
      expect(fallbacks.events).toHaveLength(1);

      await expect(tool.handler(await ctxFor(mine), { applicationId: theirs.appId })).rejects.toMatchObject({ statusCode: 404 });
      await expect(tool.handler(await ctxFor(mine), { applicationId: mine.appId, limit: 500 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(tool.handler(await ctxFor(mine), { applicationId: mine.appId, offset: 3 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it("an end user's data export carries their billing events and nobody else's", async () => {
      const w = await operatorWorld(app);
      await seed([
        paymentRecorded(w.appId, { endUserId: 'eu_export', paymentId: 'pay_mine' }),
        paymentRecorded(w.appId, { endUserId: 'eu_other', paymentId: 'pay_other' }),
      ]);
      const exported = await billingEventsForExport({ applicationId: w.appId, endUserId: 'eu_export', cap: 100 });
      expect(exported.map((e) => e.paymentId)).toEqual(['pay_mine']);
      expect(exported[0]).not.toHaveProperty('actorId');
    });
  });
});
