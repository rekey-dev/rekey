/**
 * The three ways a billing event is written. Which one a caller uses follows
 * from whether it has a transaction:
 *
 *   - `recordBillingEvent(tx, event)`: inside the transaction of the change it
 *     describes, so the two commit or roll back together.
 *   - `enqueueBillingEvent(event)`: for a change applied after its transaction
 *     committed (a coupon redemption, an unapplied payment case). The event
 *     goes to an outbox row and is drained into the log.
 *   - `recordDiagnosticBillingEvent(event)`: for a refusal, which has no
 *     transaction and must never be the reason a request fails.
 *
 * A write that repeats an (Application, type, dedupeKey) already in the log
 * is a no-op, so a redelivered webhook writes once.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { admitDiagnosticEvent } from './diagnostic-bound.js';
import {
  parseBillingEvent,
  toBillingEventRow,
  type BillingEventInput,
  type DiagnosticBillingEventInput,
} from './events.js';

type Db = Prisma.TransactionClient;

/** The part of a logger these writers use. A request logger and `app.log` both fit. */
export interface BillingLogLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

const stderr: BillingLogLogger = {
  warn: (details, message) => console.warn(message, details),
};

let scheduleDrain: (() => void) | null = null;

/**
 * Install what wakes the outbox drain after an event is enqueued. The BullMQ
 * worker does at boot; `null` removes it, and the poller alone drains.
 *
 * @example
 * setOutboxDrainScheduler(() => void queue.add('drain', {}, { delay: 1000 }));
 */
export function setOutboxDrainScheduler(fn: (() => void) | null): void {
  scheduleDrain = fn;
}

/**
 * Write one event in the caller's transaction. Returns whether a row was
 * written: false means the same event was already in the log.
 *
 * Throws `BILLING_EVENT_INVALID` for an event its schema refuses, which rolls
 * the caller's change back with it. A change with no description is the gap
 * this log exists to close.
 *
 * @example
 * await prisma.$transaction(async (tx) => {
 *   const price = await tx.planPrice.update({ where: { id }, data: { amount: 2400 } });
 *   await recordBillingEvent(tx, {
 *     type: 'plan.price_set', applicationId, actor: { type: 'operator', id: operatorId },
 *     planId: price.planId, planPriceId: price.id, currency: price.currency, amount: price.amount,
 *     data: { planSlug: 'pro', isDefault: false, before: { amount: 1900, countries: [] }, after: { amount: 2400, countries: [] } },
 *   });
 * });
 */
export async function recordBillingEvent(tx: Db, event: BillingEventInput): Promise<{ recorded: boolean }> {
  const row = toBillingEventRow(parseBillingEvent(event));
  // A diagnostic event past the hourly bound is counted, not written.
  if (!(await admitDiagnosticEvent(row))) return { recorded: false };
  // ON CONFLICT DO NOTHING. A plain insert that hit the unique index would
  // abort the transaction the caller's own change is in.
  const { count } = await tx.billingEvent.createMany({ data: [row], skipDuplicates: true });
  return { recorded: count === 1 };
}

/**
 * Write an event on a path where money has already moved or a buyer is
 * mid-checkout: a webhook applying a verified payment, a checkout being
 * opened. Never throws for an event its schema refuses. The change it
 * describes stands, and the event is kept as an outbox row that records why
 * it was refused and is retried, so a later build can still write it.
 *
 * An operator's own configuration write uses `recordBillingEvent`, which
 * fails loudly: there the operator is present to be told.
 *
 * @example
 * await prisma.$transaction(async (tx) => {
 *   const payment = await tx.payment.create({ data });
 *   await recordMoneyPathBillingEvent(tx, paymentRecorded(payment), req.log);
 * });
 */
export async function recordMoneyPathBillingEvent(
  tx: Db,
  event: BillingEventInput,
  log: BillingLogLogger = stderr,
): Promise<{ recorded: boolean; setAside: boolean }> {
  let row: Prisma.BillingEventCreateManyInput;
  try {
    row = toBillingEventRow(parseBillingEvent(event));
  } catch (err) {
    const { occurredAt, ...rest } = event;
    const payload = { ...rest, occurredAt: (occurredAt ?? new Date()).toISOString() } as unknown as Prisma.InputJsonObject;
    await tx.billingEventOutbox.create({
      data: {
        applicationId: event.applicationId,
        payload,
        attempts: 1,
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      },
    });
    log.warn(
      { err, type: event.type, applicationId: event.applicationId },
      'billing log: event refused by its schema on a money path; the change stands and the event is queued for retry',
    );
    return { recorded: false, setAside: true };
  }
  if (!(await admitDiagnosticEvent(row))) return { recorded: false, setAside: false };
  const { count } = await tx.billingEvent.createMany({ data: [row], skipDuplicates: true });
  return { recorded: count === 1, setAside: false };
}

/**
 * Queue an event for a change that has already committed, or that commits
 * with `db` when a transaction is passed. Validated now, so a malformed event
 * fails where it is written and not later in the drain.
 *
 * @example
 * const { outboxId } = await enqueueBillingEvent({
 *   type: 'coupon.redeemed', applicationId, actor: { type: 'end_user', id: endUserId }, couponId, endUserId,
 *   currency: 'USD', amount: 500,
 *   data: { code: 'LAUNCH', planSlug: 'pro', discountAmount: 500,
 *           priceCharged: { planPriceId: 'pp_1', currency: 'USD', amount: 1900 } },
 * });
 */
export async function enqueueBillingEvent(event: BillingEventInput, db: Db = prisma): Promise<{ outboxId: string }> {
  const parsed = parseBillingEvent(event);
  const payload = { ...parsed, occurredAt: parsed.occurredAt ?? new Date().toISOString() };
  const row = await db.billingEventOutbox.create({
    data: { applicationId: parsed.applicationId, payload },
    select: { id: true },
  });
  scheduleDrain?.();
  return { outboxId: row.id };
}

/**
 * Write a diagnostic event, best-effort. Never throws: a failure is logged
 * and the caller carries on with the refusal it was already returning.
 *
 * @example
 * await recordDiagnosticBillingEvent({
 *   type: 'checkout.refused', applicationId, actor: { type: 'end_user', id: endUserId }, endUserId,
 *   data: { planSlug: 'pro', code: 'BILLING_NO_PROVIDER_FOR_CURRENCY', requestedCurrency: 'INR',
 *           buyerCountry: 'IN', buyerCountrySource: 'hint' },
 * }, req.log);
 */
export async function recordDiagnosticBillingEvent(
  event: DiagnosticBillingEventInput,
  log: BillingLogLogger = stderr,
): Promise<void> {
  try {
    await recordBillingEvent(prisma, event);
  } catch (err) {
    log.warn({ err, type: event.type, applicationId: event.applicationId }, 'billing log: diagnostic event not recorded');
  }
}
