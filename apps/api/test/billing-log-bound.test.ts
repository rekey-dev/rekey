/**
 * What keeps the billing log from being filled from outside: the hourly bound
 * on diagnostic events, the row that stands for what it left out, the 90-day
 * retention, and the super-admin view of the outbox.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BillingOutboxStatusSchema } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import {
  DIAGNOSTIC_PER_APPLICATION_PER_HOUR,
  DIAGNOSTIC_PER_REASON_PER_HOUR,
  DIAGNOSTIC_RETENTION_DAYS,
  OUTBOX_FAILING_ATTEMPTS,
  flushDiagnosticAggregates,
  pruneDiagnosticEvents,
  recordBillingEvent,
  recordDiagnosticBillingEvent,
  type BillingEventInput,
} from '../src/modules/billing-log/index.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const DAY_MS = 24 * 60 * 60 * 1000;

async function newApplication(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const tenant = await prisma.tenant.create({ data: { name: `WS ${suffix}`, ownerEmail: `op-${suffix}@example.com` } });
  const application = await prisma.application.create({
    data: {
      tenantId: tenant.id,
      name: `App ${suffix}`,
      slug: `bound-${suffix}`,
      publicKey: `rp_pub_bound-${suffix}_${randomUUID().slice(0, 12)}`,
      authConfig: { mfa: 'optional', methods: ['password'], tokenAlg: 'HS256' },
      billingConfig: {},
    },
  });
  return application.id;
}

describe('billing log bounds', () => {
  let applicationId: string;

  const refused = (code = 'BILLING_NO_PROVIDER_FOR_CURRENCY', application = applicationId) =>
    ({
      type: 'checkout.refused',
      applicationId: application,
      actor: { type: 'end_user', id: 'eu_1' },
      endUserId: 'eu_1',
      data: { planSlug: 'pro', code, requestedCurrency: 'INR', buyerCountry: 'IN', buyerCountrySource: 'hint' },
    }) as Extract<BillingEventInput, { type: 'checkout.refused' }>;

  const fallback = (): BillingEventInput =>
    ({
      type: 'checkout.price_fallback',
      applicationId,
      actor: { type: 'end_user', id: 'eu_1' },
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
    }) as BillingEventInput;

  const count = (where: Record<string, unknown> = {}) => prisma.billingEvent.count({ where: { applicationId, ...where } });
  const aggregates = () =>
    prisma.billingEvent.findMany({ where: { applicationId, type: 'diagnostic.aggregated' }, orderBy: { seq: 'asc' } });

  beforeEach(async () => {
    applicationId = await newApplication();
  });

  describe('diagnostic events per hour', () => {
    it('writes exactly the first twenty of one reason under eight concurrent writers, and counts the rest', async () => {
      const racers = Array.from({ length: 8 }, async () => {
        for (let i = 0; i < 10; i += 1) await recordDiagnosticBillingEvent(refused());
      });
      await Promise.all(racers);

      expect(await count({ type: 'checkout.refused' })).toBe(DIAGNOSTIC_PER_REASON_PER_HOUR);
      expect(await aggregates()).toHaveLength(0);

      expect(await flushDiagnosticAggregates()).toBe(1);
      const [aggregate] = await aggregates();
      expect(aggregate).toMatchObject({
        tier: 'DIAGNOSTIC',
        actorType: 'SYSTEM',
        data: { eventType: 'checkout.refused', reason: 'BILLING_NO_PROVIDER_FOR_CURRENCY', suppressed: 60 },
      });
      expect(new Date((aggregate!.data as { windowStart: string }).windowStart).getUTCMinutes()).toBe(0);

      // More of the same in the same hour raise the one row; nothing is added.
      for (let i = 0; i < 5; i += 1) await recordDiagnosticBillingEvent(refused());
      expect(await flushDiagnosticAggregates()).toBe(1);
      expect(await flushDiagnosticAggregates()).toBe(0);
      const after = await aggregates();
      expect(after).toHaveLength(1);
      expect(after[0]!.data).toMatchObject({ suppressed: 65 });
      expect(await count()).toBe(DIAGNOSTIC_PER_REASON_PER_HOUR + 1);
    });

    it('caps one Application at two hundred diagnostic events an hour across every reason', async () => {
      for (let reason = 0; reason < 12; reason += 1) {
        for (let i = 0; i < DIAGNOSTIC_PER_REASON_PER_HOUR; i += 1) {
          await recordDiagnosticBillingEvent(refused(`BILLING_REFUSAL_${reason}`));
        }
      }
      expect(await count({ type: 'checkout.refused' })).toBe(DIAGNOSTIC_PER_APPLICATION_PER_HOUR);
      await flushDiagnosticAggregates();
      const suppressed = (await aggregates()).reduce((sum, row) => sum + (row.data as { suppressed: number }).suppressed, 0);
      expect(suppressed).toBe(12 * DIAGNOSTIC_PER_REASON_PER_HOUR - DIAGNOSTIC_PER_APPLICATION_PER_HOUR);
    });

    it('skips the count of an Application deleted while its counters were live', async () => {
      const doomed = await newApplication();
      for (let i = 0; i < DIAGNOSTIC_PER_REASON_PER_HOUR + 3; i += 1) await recordDiagnosticBillingEvent(refused('BILLING_CURRENCY_CONFLICT', doomed));
      for (let i = 0; i < DIAGNOSTIC_PER_REASON_PER_HOUR + 2; i += 1) await recordDiagnosticBillingEvent(refused());
      await prisma.application.delete({ where: { id: doomed } });
      // The surviving Application's row is still written.
      expect(await flushDiagnosticAggregates()).toBe(1);
      expect((await aggregates())[0]!.data).toMatchObject({ suppressed: 2 });
    });

    it('never bounds a permanent event', async () => {
      for (let i = 0; i < 3 * DIAGNOSTIC_PER_REASON_PER_HOUR; i += 1) await recordBillingEvent(prisma, fallback());
      expect(await count({ type: 'checkout.price_fallback' })).toBe(3 * DIAGNOSTIC_PER_REASON_PER_HOUR);
    });
  });

  describe('retention', () => {
    it('deletes diagnostic events older than ninety days and nothing else', async () => {
      const row = (key: string, tier: 'PERMANENT' | 'DIAGNOSTIC', ageDays: number) => ({
        applicationId,
        type: tier === 'DIAGNOSTIC' ? 'checkout.refused' : 'payment.recorded',
        tier,
        occurredAt: new Date(Date.now() - ageDays * DAY_MS),
        recordedAt: new Date(Date.now() - ageDays * DAY_MS),
        dedupeKey: key,
        actorType: 'SYSTEM' as const,
        data: {},
      });
      await prisma.billingEvent.createMany({
        data: [
          row('old-diagnostic', 'DIAGNOSTIC', DIAGNOSTIC_RETENTION_DAYS + 1),
          row('young-diagnostic', 'DIAGNOSTIC', DIAGNOSTIC_RETENTION_DAYS - 1),
          row('old-permanent', 'PERMANENT', 4 * DIAGNOSTIC_RETENTION_DAYS),
        ],
      });

      expect(await pruneDiagnosticEvents()).toBe(1);
      const kept = await prisma.billingEvent.findMany({ where: { applicationId }, select: { dedupeKey: true } });
      expect(kept.map((r) => r.dedupeKey).sort()).toEqual(['old-permanent', 'young-diagnostic']);
      expect(await pruneDiagnosticEvents()).toBe(0);
    });
  });

  describe('outbox status for the super-admin', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await buildApp({ logger: false });
      await app.ready();
    });
    afterAll(async () => {
      await app.close();
    });

    const status = (headers: Record<string, string> = { authorization: `Bearer ${ADMIN_KEY}` }) =>
      app.inject({ method: 'GET', url: '/api/v1/admin/metrics/billing-outbox', headers });

    it('counts what is waiting and lists the rows that keep failing, without their payloads', async () => {
      const payload = { type: 'coupon.redeemed', applicationId, secretLookingField: 'do-not-return' };
      const queued = (attempts: number, extra: Record<string, unknown> = {}) =>
        prisma.billingEventOutbox.create({
          data: { applicationId, payload, attempts, lastError: attempts > 0 ? 'data.code: Required' : null, ...extra },
        });
      await queued(0);
      await queued(OUTBOX_FAILING_ATTEMPTS - 1, { nextAttemptAt: new Date(Date.now() + DAY_MS) });
      const five = await queued(OUTBOX_FAILING_ATTEMPTS, { nextAttemptAt: new Date(Date.now() + DAY_MS) });
      const nine = await queued(9, { nextAttemptAt: new Date(Date.now() + DAY_MS) });
      await queued(12, { processedAt: new Date() });

      const res = await status();
      expect(res.statusCode, res.body).toBe(200);
      const data = BillingOutboxStatusSchema.parse(res.json().data);
      expect(data).toMatchObject({ pending: 4, due: 1, failing: 2, failingThreshold: OUTBOX_FAILING_ATTEMPTS });
      expect(data.oldestPendingAt).not.toBeNull();
      expect(data.stuck.map((row) => [row.id, row.attempts, row.type, row.lastError])).toEqual([
        [nine.id, 9, 'coupon.redeemed', 'data.code: Required'],
        [five.id, OUTBOX_FAILING_ATTEMPTS, 'coupon.redeemed', 'data.code: Required'],
      ]);
      expect(res.body).not.toContain('do-not-return');
    });

    it('needs the super-admin key', async () => {
      expect((await status({})).statusCode).toBe(401);
      expect((await status({ authorization: 'Bearer wrong' })).statusCode).toBe(401);
    });
  });
});
