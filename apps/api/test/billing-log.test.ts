/**
 * The billing log's write side: the three writers, deduplication, the
 * append-only trigger, the outbox drain, and the shapes that keep personal
 * data out.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BILLING_EVENT_TIER, BILLING_EVENT_TYPES, BillingEventSchema } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import {
  drainBillingEventOutbox,
  enqueueBillingEvent,
  parseBillingEvent,
  recordBillingEvent,
  pruneProcessedOutbox,
  recordDiagnosticBillingEvent,
  recordMoneyPathBillingEvent,
  retryDelayMs,
  serializeBillingEvent,
  setOutboxDrainScheduler,
  type BillingEventInput,
} from '../src/modules/billing-log/index.js';

const MAINTENANCE = `SET LOCAL rekey.billing_events_maintenance = 'on'`;

describe('billing log writers', () => {
  let applicationId: string;

  async function newApplication(): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const tenant = await prisma.tenant.create({ data: { name: `WS ${suffix}`, ownerEmail: `op-${suffix}@example.com` } });
    const application = await prisma.application.create({
      data: {
        tenantId: tenant.id,
        name: `App ${suffix}`,
        slug: `log-${suffix}`,
        publicKey: `rp_pub_log-${suffix}_${randomUUID().slice(0, 12)}`,
        authConfig: { mfa: 'optional', methods: ['password'], tokenAlg: 'HS256' },
        billingConfig: {},
      },
    });
    return application.id;
  }

  const priceSet = (over: Partial<BillingEventInput> = {}): BillingEventInput =>
    ({
      type: 'plan.price_set',
      applicationId,
      actor: { type: 'operator', id: 'op_1' },
      planId: 'plan_1',
      planPriceId: 'pp_1',
      currency: 'INR',
      amount: 149900,
      data: { planSlug: 'pro', isDefault: false, before: null, after: { amount: 149900, countries: ['IN'] } },
      ...over,
    }) as BillingEventInput;

  const refused = (over: Partial<BillingEventInput> = {}) =>
    ({
      type: 'checkout.refused',
      applicationId,
      actor: { type: 'end_user', id: 'eu_1' },
      endUserId: 'eu_1',
      data: {
        planSlug: 'pro',
        code: 'BILLING_NO_PROVIDER_FOR_CURRENCY',
        requestedCurrency: 'INR',
        buyerCountry: 'IN',
        buyerCountrySource: 'hint',
      },
      ...over,
    }) as Extract<BillingEventInput, { type: 'checkout.refused' }>;

  const events = () => prisma.billingEvent.findMany({ where: { applicationId }, orderBy: { seq: 'asc' } });

  beforeEach(async () => {
    applicationId = await newApplication();
    setOutboxDrainScheduler(null);
  });

  describe('recordBillingEvent', () => {
    it('writes the event with its references, tier and actor, in the caller transaction', async () => {
      const occurredAt = new Date('2026-10-01T10:00:00.000Z');
      const result = await prisma.$transaction((tx) => recordBillingEvent(tx, priceSet({ occurredAt })));
      expect(result).toEqual({ recorded: true });

      const [row] = await events();
      expect(row).toMatchObject({
        type: 'plan.price_set',
        tier: 'PERMANENT',
        actorType: 'OPERATOR',
        actorId: 'op_1',
        planId: 'plan_1',
        planPriceId: 'pp_1',
        currency: 'INR',
        amount: 149900,
        endUserId: null,
        paymentId: null,
        data: { planSlug: 'pro', isDefault: false, before: null, after: { amount: 149900, countries: ['IN'] } },
      });
      expect(row!.occurredAt.toISOString()).toBe(occurredAt.toISOString());
      expect(typeof row!.seq).toBe('bigint');
      expect(row!.dedupeKey.length).toBeGreaterThan(0);
    });

    it('rolls back with the change it describes', async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await recordBillingEvent(tx, priceSet());
          throw new Error('the change failed');
        }),
      ).rejects.toThrow('the change failed');
      expect(await events()).toEqual([]);
    });

    it('numbers events in the order they were written', async () => {
      await recordBillingEvent(prisma, priceSet());
      await recordBillingEvent(prisma, priceSet());
      const [first, second] = await events();
      expect(second!.seq > first!.seq).toBe(true);
    });

    it('an invalid event throws and takes the transaction with it', async () => {
      const bad = priceSet({ data: { planSlug: 'pro', isDefault: false, before: null, after: { amount: 0, countries: [] } } } as never);
      await expect(prisma.$transaction((tx) => recordBillingEvent(tx, bad))).rejects.toMatchObject({
        code: 'BILLING_EVENT_INVALID',
        fix: expect.stringContaining('BillingEventSchema'),
      });
      expect(await events()).toEqual([]);
    });
  });

  describe('deduplication', () => {
    it('a second write with the same key is a no-op, and leaves its transaction usable', async () => {
      const event = priceSet({ dedupeKey: 'price-change-1' });
      expect(await recordBillingEvent(prisma, event)).toEqual({ recorded: true });

      const again = await prisma.$transaction(async (tx) => {
        const result = await recordBillingEvent(tx, { ...event, amount: 99900 } as BillingEventInput);
        // A unique violation would have aborted the transaction: this read proves it did not.
        await tx.application.findUniqueOrThrow({ where: { id: applicationId } });
        return result;
      });
      expect(again).toEqual({ recorded: false });
      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.amount).toBe(149900);
    });

    it('falls back to the provider event id, so a redelivered webhook writes once', async () => {
      const event = priceSet({ provider: 'stripe', providerEventId: 'evt_123' });
      await recordBillingEvent(prisma, event);
      await recordBillingEvent(prisma, event);
      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dedupeKey: 'plan.price_set:evt_123:', providerEventId: 'evt_123', provider: 'stripe' });
    });

    it('keeps two things one provider event is about apart: two refunds, two unapplied cases', async () => {
      const refund = (refundId: string): BillingEventInput => ({
        type: 'payment.refunded',
        applicationId,
        actor: { type: 'provider' },
        provider: 'stripe',
        providerEventId: 'evt_two_refunds',
        paymentId: 'pay_1',
        refundId,
        currency: 'USD',
        amount: 500,
        data: { refundedAmount: 500, totalRefunded: 500, providerRefundId: refundId, initiatedBy: 'provider', reasonCode: null },
      });
      const unapplied = (caseId: string): BillingEventInput => ({
        type: 'payment.unapplied',
        applicationId,
        actor: { type: 'system' },
        provider: 'paypal',
        providerEventId: 'WH-one-event',
        data: { unappliedPaymentId: caseId, reasonCode: 'no_subscription' },
      });
      for (const event of [refund('re_1'), refund('re_2'), unapplied('case_1'), unapplied('case_2')]) {
        expect(await recordBillingEvent(prisma, event)).toEqual({ recorded: true });
      }
      // The same four again, as a redelivery: nothing new.
      for (const event of [refund('re_1'), refund('re_2'), unapplied('case_1'), unapplied('case_2')]) {
        expect(await recordBillingEvent(prisma, event)).toEqual({ recorded: false });
      }
      expect((await events()).map((row) => row.dedupeKey)).toEqual([
        'payment.refunded:evt_two_refunds:re_1',
        'payment.refunded:evt_two_refunds:re_2',
        'payment.unapplied:WH-one-event:case_1',
        'payment.unapplied:WH-one-event:case_2',
      ]);
    });

    it('the key is per Application and per type', async () => {
      const other = await newApplication();
      await recordBillingEvent(prisma, priceSet({ dedupeKey: 'k' }));
      await recordBillingEvent(prisma, priceSet({ dedupeKey: 'k', applicationId: other }));
      await recordBillingEvent(prisma, refused({ dedupeKey: 'k' }));
      expect(await prisma.billingEvent.count({ where: { dedupeKey: 'k' } })).toBe(3);
    });

    it('events with no key and no provider id are never merged', async () => {
      await recordBillingEvent(prisma, priceSet());
      await recordBillingEvent(prisma, priceSet());
      expect(await events()).toHaveLength(2);
    });
  });

  describe('the append-only trigger', () => {
    let eventId: string;
    beforeEach(async () => {
      await recordBillingEvent(prisma, priceSet());
      eventId = (await events())[0]!.id;
    });

    it('refuses UPDATE', async () => {
      await expect(prisma.billingEvent.update({ where: { id: eventId }, data: { amount: 1 } })).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRaw`UPDATE "billing_events" SET "amount" = 1 WHERE "id" = ${eventId}`).rejects.toThrow(/append-only/);
      expect((await events())[0]!.amount).toBe(149900);
    });

    it('refuses DELETE', async () => {
      await expect(prisma.billingEvent.delete({ where: { id: eventId } })).rejects.toThrow(/append-only/);
      await expect(prisma.billingEvent.deleteMany({ where: { applicationId } })).rejects.toThrow(/append-only/);
      expect(await events()).toHaveLength(1);
    });

    it('allows both inside a transaction that sets the maintenance setting, and only there', async () => {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(MAINTENANCE);
        await tx.billingEvent.update({ where: { id: eventId }, data: { data: {} } });
      });
      expect((await events())[0]!.data).toEqual({});

      // SET LOCAL ended with that transaction.
      await expect(prisma.billingEvent.delete({ where: { id: eventId } })).rejects.toThrow(/append-only/);

      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(MAINTENANCE);
        await tx.billingEvent.delete({ where: { id: eventId } });
      });
      expect(await events()).toEqual([]);
    });

    it('any other value of the setting is not maintenance', async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL rekey.billing_events_maintenance = 'off'`);
          await tx.billingEvent.delete({ where: { id: eventId } });
        }),
      ).rejects.toThrow(/append-only/);
    });

    it('lets the log go with its Application', async () => {
      await prisma.application.delete({ where: { id: applicationId } });
      expect(await prisma.billingEvent.count({ where: { applicationId } })).toBe(0);
    });
  });

  describe('enqueueBillingEvent and the drain', () => {
    it('queues the event and wakes the drain, without writing the log yet', async () => {
      const wake = vi.fn();
      setOutboxDrainScheduler(wake);
      const { outboxId } = await enqueueBillingEvent(priceSet());
      expect(wake).toHaveBeenCalledTimes(1);
      expect(await events()).toEqual([]);
      const row = await prisma.billingEventOutbox.findUniqueOrThrow({ where: { id: outboxId } });
      expect(row).toMatchObject({ applicationId, processedAt: null });
      expect(row.payload).toMatchObject({ type: 'plan.price_set', occurredAt: expect.any(String) });
    });

    it('commits or rolls back with the transaction it is given', async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await enqueueBillingEvent(priceSet(), tx);
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      expect(await prisma.billingEventOutbox.count({ where: { applicationId } })).toBe(0);
    });

    it('refuses an invalid event where it is queued', async () => {
      await expect(enqueueBillingEvent(priceSet({ currency: 'rupees' } as never))).rejects.toMatchObject({ code: 'BILLING_EVENT_INVALID' });
      expect(await prisma.billingEventOutbox.count({ where: { applicationId } })).toBe(0);
    });

    it('drains queued events into the log once, keeping when they happened', async () => {
      const occurredAt = new Date('2026-09-30T08:00:00.000Z');
      const { outboxId } = await enqueueBillingEvent(priceSet({ occurredAt }));
      await enqueueBillingEvent(refused());

      expect(await drainBillingEventOutbox()).toBe(2);
      const rows = await events();
      expect(rows.map((row) => row.type)).toEqual(['plan.price_set', 'checkout.refused']);
      expect(rows[0]!.occurredAt.toISOString()).toBe(occurredAt.toISOString());
      expect(rows[0]!.dedupeKey).toBe(`outbox:${outboxId}`);
      expect(await prisma.billingEventOutbox.count({ where: { applicationId, processedAt: null } })).toBe(0);

      expect(await drainBillingEventOutbox()).toBe(0);
      expect(await events()).toHaveLength(2);
    });

    it('a drain that died after writing the event does not write it twice', async () => {
      const { outboxId } = await enqueueBillingEvent(priceSet());
      await drainBillingEventOutbox();
      // As if the event were queued a second time by a retry of whatever queued it.
      const again = await enqueueBillingEvent(priceSet({ dedupeKey: `outbox:${outboxId}` }));
      expect(await drainBillingEventOutbox()).toBe(1);
      expect(await events()).toHaveLength(1);
      expect((await prisma.billingEventOutbox.findUniqueOrThrow({ where: { id: again.outboxId } })).processedAt).not.toBeNull();
    });

    it('one provider event queued twice is logged once', async () => {
      const event = priceSet({ provider: 'stripe', providerEventId: 'evt_dup' });
      await enqueueBillingEvent(event);
      await enqueueBillingEvent(event);
      expect(await drainBillingEventOutbox()).toBe(2);
      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dedupeKey).toBe('plan.price_set:evt_dup:');
    });

    it('clears the payload of a row once its event is in the log', async () => {
      const { outboxId } = await enqueueBillingEvent(priceSet());
      await drainBillingEventOutbox();
      expect(await prisma.billingEventOutbox.findUniqueOrThrow({ where: { id: outboxId } })).toMatchObject({
        payload: null,
        attempts: 0,
        lastError: null,
      });
    });

    it('overlapping drains write each event once', async () => {
      for (let i = 0; i < 6; i += 1) await enqueueBillingEvent(priceSet());
      await Promise.all(Array.from({ length: 8 }, () => drainBillingEventOutbox()));
      expect(await events()).toHaveLength(6);
      expect(await prisma.billingEventOutbox.count({ where: { applicationId, processedAt: null } })).toBe(0);
    });

    it('keeps a payload this build cannot read for a later one, and carries on with the rest', async () => {
      const warn = vi.fn();
      // What an older pod sees when a newer one queued an event type it has no schema for.
      const fromNewerBuild = { type: 'invoice.finalised', applicationId, actor: { type: 'system' }, data: { invoiceId: 'in_1' } };
      const unreadable = await prisma.billingEventOutbox.create({ data: { applicationId, payload: fromNewerBuild } });
      await enqueueBillingEvent(refused());

      const before = Date.now();
      expect(await drainBillingEventOutbox(100, { warn })).toBe(1);
      expect((await events()).map((row) => row.type)).toEqual(['checkout.refused']);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ outboxId: unreadable.id, attempts: 1 }), expect.any(String));

      const kept = await prisma.billingEventOutbox.findUniqueOrThrow({ where: { id: unreadable.id } });
      expect(kept.processedAt).toBeNull();
      expect(kept.payload).toEqual(fromNewerBuild);
      expect(kept.attempts).toBe(1);
      expect(kept.lastError).toEqual(expect.stringContaining('type'));
      expect(kept.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + retryDelayMs(1) - 1000);

      // Not due yet: the next drain leaves it alone instead of spinning on it.
      expect(await drainBillingEventOutbox(100, { warn })).toBe(0);
      expect((await prisma.billingEventOutbox.findUniqueOrThrow({ where: { id: unreadable.id } })).attempts).toBe(1);

      // Due again and still unreadable: it backs off further, and is still there.
      await prisma.billingEventOutbox.update({ where: { id: unreadable.id }, data: { nextAttemptAt: new Date(0) } });
      await drainBillingEventOutbox(100, { warn });
      const retried = await prisma.billingEventOutbox.findUniqueOrThrow({ where: { id: unreadable.id } });
      expect(retried).toMatchObject({ attempts: 2, processedAt: null });
      expect(retried.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + retryDelayMs(2) - 1000);
    });

    it('writes it once a build that can read it drains', async () => {
      // The same row, readable: stands in for the newer build draining what the older one kept.
      const row = await prisma.billingEventOutbox.create({
        data: { applicationId, payload: { type: 'no.such.type', applicationId, actor: { type: 'system' }, data: {} } },
      });
      await drainBillingEventOutbox();
      const readable = { ...refused(), occurredAt: new Date().toISOString() };
      await prisma.billingEventOutbox.update({ where: { id: row.id }, data: { payload: readable, nextAttemptAt: new Date(0) } });
      expect(await drainBillingEventOutbox()).toBe(1);
      expect((await events()).map((event) => event.type)).toEqual(['checkout.refused']);
    });

    it('backs off from a minute, doubling, to six hours at most', () => {
      expect([1, 2, 3, 4, 20].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 21_600_000]);
    });

    it('prunes rows processed more than a week ago, and never an unprocessed one', async () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const { outboxId: done } = await enqueueBillingEvent(priceSet());
      const { outboxId: recent } = await enqueueBillingEvent(priceSet());
      await drainBillingEventOutbox();
      await prisma.billingEventOutbox.update({ where: { id: done }, data: { processedAt: old } });
      const stuck = await prisma.billingEventOutbox.create({
        data: { applicationId, payload: { type: 'no.such.type' }, createdAt: old, nextAttemptAt: new Date(Date.now() + 3_600_000) },
      });

      await drainBillingEventOutbox();
      const left = (await prisma.billingEventOutbox.findMany({ where: { applicationId } })).map((row) => row.id);
      expect(left.sort()).toEqual([recent, stuck.id].sort());
      expect(await pruneProcessedOutbox()).toBe(0);
    });
  });

  describe('recordMoneyPathBillingEvent', () => {
    const invalid = () => ({ ...priceSet(), data: { planSlug: 'pro', email: 'buyer@example.com' } }) as unknown as BillingEventInput;

    it('writes a valid event in the transaction, like recordBillingEvent', async () => {
      const result = await prisma.$transaction((tx) => recordMoneyPathBillingEvent(tx, priceSet()));
      expect(result).toEqual({ recorded: true, setAside: false });
      expect(await events()).toHaveLength(1);
    });

    it('never rolls back the change for an event its schema refuses: the change commits and the event is queued', async () => {
      const warn = vi.fn();
      const result = await prisma.$transaction(async (tx) => {
        await tx.application.update({ where: { id: applicationId }, data: { name: 'money moved' } });
        return recordMoneyPathBillingEvent(tx, invalid(), { warn });
      });
      expect(result).toEqual({ recorded: false, setAside: true });
      expect((await prisma.application.findUniqueOrThrow({ where: { id: applicationId } })).name).toBe('money moved');
      expect(await events()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);

      const [queued] = await prisma.billingEventOutbox.findMany({ where: { applicationId } });
      expect(queued).toMatchObject({ processedAt: null, attempts: 1 });
      expect(queued!.lastError).toEqual(expect.stringContaining('was refused at'));
      expect(queued!.payload).toMatchObject({ type: 'plan.price_set', data: { email: 'buyer@example.com' } });
      // The drain does not write it either: it stays, unprocessed, for a person or a later build.
      await prisma.billingEventOutbox.update({ where: { id: queued!.id }, data: { nextAttemptAt: new Date(0) } });
      await drainBillingEventOutbox();
      expect(await events()).toEqual([]);
      expect((await prisma.billingEventOutbox.findUniqueOrThrow({ where: { id: queued!.id } })).processedAt).toBeNull();
    });

    it('the operator writer still fails loudly for the same event', async () => {
      await expect(prisma.$transaction((tx) => recordBillingEvent(tx, invalid()))).rejects.toMatchObject({
        code: 'BILLING_EVENT_INVALID',
      });
    });
  });

  describe('serializeBillingEvent', () => {
    it('gives a stored event a shape JSON can carry: seq as a string', async () => {
      await recordBillingEvent(prisma, priceSet());
      const [row] = await events();
      expect(() => JSON.stringify(row)).toThrow(/BigInt/);
      const record = serializeBillingEvent(row!);
      expect(record.seq).toBe(row!.seq.toString());
      expect(JSON.parse(JSON.stringify(record))).toMatchObject({
        seq: row!.seq.toString(),
        type: 'plan.price_set',
        occurredAt: row!.occurredAt.toISOString(),
        recordedAt: row!.recordedAt.toISOString(),
      });
    });
  });

  describe('recordDiagnosticBillingEvent', () => {
    it('writes a diagnostic event', async () => {
      await recordDiagnosticBillingEvent(refused());
      expect(await events()).toEqual([expect.objectContaining({ type: 'checkout.refused', tier: 'DIAGNOSTIC', actorType: 'END_USER' })]);
    });

    it('never throws: an invalid event and a failed insert are logged', async () => {
      const warn = vi.fn();
      await expect(recordDiagnosticBillingEvent(refused({ data: { nope: true } } as never), { warn })).resolves.toBeUndefined();
      await expect(recordDiagnosticBillingEvent(refused({ applicationId: 'app_missing' }), { warn })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ type: 'checkout.refused' }), expect.stringContaining('not recorded'));
      expect(await events()).toEqual([]);
    });
  });

  describe('what an event may carry', () => {
    it('has a data schema and a tier for every type, and refusals are diagnostic', () => {
      expect(BILLING_EVENT_TYPES.length).toBeGreaterThanOrEqual(23);
      for (const type of BILLING_EVENT_TYPES) expect(BILLING_EVENT_TIER[type], type).toMatch(/^(PERMANENT|DIAGNOSTIC)$/);
      const diagnostic = BILLING_EVENT_TYPES.filter((type) => BILLING_EVENT_TIER[type] === 'DIAGNOSTIC');
      expect(diagnostic.sort()).toEqual(['checkout.expired', 'checkout.opened', 'checkout.refused', 'coupon.refused', 'diagnostic.aggregated', 'reconciliation.finding']);
    });

    it('refuses a field nobody declared, at every level: email, IP address, user agent', () => {
      const base = refused();
      const withData = (extra: object) => ({ ...base, data: { ...base.data, ...extra } });
      const attempts: unknown[] = [
        { ...base, email: 'buyer@example.com' },
        { ...base, ip: '203.0.113.9' },
        { ...base, userAgent: 'Mozilla/5.0' },
        withData({ email: 'buyer@example.com' }),
        withData({ ipAddress: '203.0.113.9' }),
        withData({ userAgent: 'Mozilla/5.0' }),
        { ...base, actor: { type: 'end_user', id: 'eu_1', email: 'buyer@example.com' } },
      ];
      for (const attempt of attempts) {
        expect(BillingEventSchema.safeParse(attempt).success, JSON.stringify(attempt)).toBe(false);
        expect(() => parseBillingEvent(attempt as BillingEventInput)).toThrow(/billing event was refused/);
      }
      expect(BillingEventSchema.safeParse(base).success).toBe(true);
    });

    it('refuses an email address hiding in a declared field', () => {
      const base = refused();
      const attempts: unknown[] = [
        { ...base, actor: { type: 'end_user', id: 'buyer@example.com' } },
        { ...base, endUserId: 'buyer@example.com' },
        { ...base, dedupeKey: 'refusal for buyer@example.com' },
        { ...base, data: { ...base.data, planSlug: 'buyer@example.com' } },
        { ...base, data: { ...base.data, code: 'buyer@example.com' } },
      ];
      for (const attempt of attempts) {
        expect(BillingEventSchema.safeParse(attempt).success, JSON.stringify(attempt)).toBe(false);
      }
    });

    it('refuses data that belongs to another type, and an unknown type', () => {
      const wrongData = { ...priceSet(), data: refused().data };
      expect(BillingEventSchema.safeParse(wrongData).success).toBe(false);
      expect(BillingEventSchema.safeParse({ ...priceSet(), type: 'plan.price_guessed' }).success).toBe(false);
    });
  });
});

describe('the reference call site: plan.price_set', () => {
  let app: FastifyInstance;
  let operatorAccess: string;
  let applicationId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const operator = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
    app.inject({
      method,
      url: `/api/v1/tenant/applications/${applicationId}${url}`,
      headers: { authorization: `Bearer ${operatorAccess}` },
      ...(payload !== undefined && { payload }),
    });

  beforeEach(async () => {
    const slug = `ps-${randomUUID().slice(0, 8)}`;
    operatorAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: 'Sup3r-Secret-Pass!', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const created = await operator('POST', '/plans', { slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 2000 } });
    expect(created.statusCode, created.body).toBe(201);
  });

  it('records the price before and after, by the operator who set it, and nothing when nothing changed', async () => {
    const first = await operator('PUT', '/plans/pro/prices/inr', { amount: 149900 });
    expect(first.statusCode, first.body).toBe(200);
    const priceId = (first.json().data as { id: string }).id;
    await operator('PUT', '/plans/pro/prices/INR', { amount: 99900, countries: ['in'] });
    // The same values again: no change, no event.
    await operator('PUT', '/plans/pro/prices/INR', { amount: 99900, countries: ['IN'] });

    const rows = await prisma.billingEvent.findMany({ where: { applicationId, currency: 'INR' }, orderBy: { seq: 'asc' } });
    expect(rows).toHaveLength(2);
    const operatorId = (await prisma.tenantUser.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })).id;
    expect(rows[0]).toMatchObject({
      type: 'plan.price_set',
      tier: 'PERMANENT',
      actorType: 'OPERATOR',
      actorId: operatorId,
      planPriceId: priceId,
      currency: 'INR',
      amount: 149900,
      data: { planSlug: 'pro', isDefault: false, before: null, after: { amount: 149900, countries: [] } },
    });
    expect(rows[1]).toMatchObject({
      amount: 99900,
      data: { before: { amount: 149900, countries: [] }, after: { amount: 99900, countries: ['IN'] } },
    });
  });

  it('records nothing for a change that was refused', async () => {
    const refusedPut = await operator('PUT', '/plans/pro/prices/KWD', { amount: 1000 });
    expect(refusedPut.statusCode).toBe(400);
    expect(await prisma.billingEvent.count({ where: { applicationId, currency: 'KWD' } })).toBe(0);
    const refusedPatch = await operator('PATCH', '/plans/pro', { price: { currency: 'USD', amount: -5 } });
    expect(refusedPatch.statusCode).toBe(400);
    expect(await prisma.billingEvent.count({ where: { applicationId } })).toBe(1);
  });

  it('records the default price a plan is created with, and each change to it through PATCH /plans', async () => {
    const operatorId = (await prisma.tenantUser.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })).id;
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId, slug: 'pro' } });
    const created = await prisma.billingEvent.findMany({ where: { applicationId }, orderBy: { seq: 'asc' } });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'plan.price_set',
      actorType: 'OPERATOR',
      actorId: operatorId,
      planId: plan.id,
      planPriceId: plan.defaultPriceId,
      currency: 'USD',
      amount: 2000,
      data: { planSlug: 'pro', isDefault: true, before: null, after: { amount: 2000, countries: [] } },
    });

    const repriced = await operator('PATCH', '/plans/pro', { price: { currency: 'USD', amount: 2400 } });
    expect(repriced.statusCode, repriced.body).toBe(200);
    // A rename is not a price change.
    expect((await operator('PATCH', '/plans/pro', { name: 'Pro plan' })).statusCode).toBe(200);
    const after = await prisma.billingEvent.findMany({ where: { applicationId }, orderBy: { seq: 'asc' } });
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({
      type: 'plan.price_set',
      actorId: operatorId,
      planPriceId: plan.defaultPriceId,
      currency: 'USD',
      amount: 2400,
      data: { isDefault: true, before: { amount: 2000, countries: [] }, after: { amount: 2400, countries: [] } },
    });
  });

  it('records a default price that moves to another currency as one price retired and one set', async () => {
    const before = await prisma.plan.findFirstOrThrow({ where: { applicationId, slug: 'pro' } });
    const moved = await operator('PATCH', '/plans/pro', { price: { currency: 'eur', amount: 1800 } });
    expect(moved.statusCode, moved.body).toBe(200);
    const events = await prisma.billingEvent.findMany({ where: { applicationId }, orderBy: { seq: 'asc' } });
    expect(events.map((event) => [event.type, event.currency, event.amount])).toEqual([
      ['plan.price_set', 'USD', 2000],
      ['plan.price_archived', 'USD', 2000],
      ['plan.price_set', 'EUR', 1800],
    ]);
    expect(events[1]).toMatchObject({ planPriceId: before.defaultPriceId, data: { planSlug: 'pro', amount: 2000, outcome: 'deleted' } });
    expect(events[2]!.data).toMatchObject({ isDefault: true, before: null });
  });

  it('records a price that is removed, by the operator who removed it', async () => {
    const put = await operator('PUT', '/plans/pro/prices/INR', { amount: 149900 });
    const priceId = (put.json().data as { id: string }).id;
    const removed = await operator('DELETE', '/plans/pro/prices/INR');
    expect(removed.statusCode, removed.body).toBe(200);
    const operatorId = (await prisma.tenantUser.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })).id;
    const [event] = await prisma.billingEvent.findMany({ where: { applicationId, type: 'plan.price_archived' } });
    expect(event).toMatchObject({
      actorType: 'OPERATOR',
      actorId: operatorId,
      planPriceId: priceId,
      currency: 'INR',
      amount: 149900,
      data: { planSlug: 'pro', amount: 149900, outcome: 'deleted' },
    });
  });
});
