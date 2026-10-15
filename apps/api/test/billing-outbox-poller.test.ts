/**
 * The billing event outbox poller: one statement when idle, drains what is
 * due, prunes what was processed long ago.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import {
  drainBillingEventOutbox,
  enqueueBillingEvent,
  pollBillingEventOutbox,
} from '../src/modules/billing-log/index.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('billing event outbox poller', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await twoCurrencyWorld(app);
  });

  describe('the billing event outbox poller', () => {
    const queueOne = () =>
      enqueueBillingEvent({
        applicationId: w.applicationId,
        actor: { type: 'system' },
        type: 'settings.local_prices_changed',
        data: { before: 'trusted', after: 'any' },
      });

    it('drains a row that is due and leaves one that is not', async () => {
      await drainBillingEventOutbox(1000);
      const due = await queueOne();
      const later = await queueOne();
      await prisma.billingEventOutbox.update({ where: { id: later.outboxId }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });

      expect(await pollBillingEventOutbox()).toBe(1);
      expect((await prisma.billingEventOutbox.findUniqueOrThrow({ where: { id: due.outboxId } })).processedAt).not.toBeNull();
      expect((await prisma.billingEventOutbox.findUniqueOrThrow({ where: { id: later.outboxId } })).processedAt).toBeNull();
    });

    it('prunes a row processed long ago even when nothing is due', async () => {
      const { outboxId } = await queueOne();
      await drainBillingEventOutbox(1000);
      await prisma.billingEventOutbox.update({ where: { id: outboxId }, data: { processedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } });

      expect(await pollBillingEventOutbox()).toBe(0);
      expect(await prisma.billingEventOutbox.findUnique({ where: { id: outboxId } })).toBeNull();
    });
  });
});
