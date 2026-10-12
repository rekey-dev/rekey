/**
 * Turns a billing event a writer hands over into the row that is stored.
 *
 * The event shapes live in `@rekey.dev/shared-types` (`BillingEventSchema`),
 * so the panel types the read side from the same union. This file validates
 * against it and maps it onto `billing_events`.
 */

import { randomUUID } from 'node:crypto';
import type { BillingEvent as BillingEventRow, Prisma } from '@prisma/client';
import {
  BILLING_EVENT_TIER,
  BillingEventSchema,
  type BillingEvent,
  type BillingEventType,
  type DiagnosticBillingEventType,
} from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';

/** A billing event as a writer passes it: the stored shape, with `occurredAt` as a `Date`. */
export type BillingEventInput = BillingEvent extends infer E
  ? E extends BillingEvent
    ? Omit<E, 'occurredAt'> & { occurredAt?: Date | undefined }
    : never
  : never;

/** The events that record a refusal or an opened checkout, which have no transaction to join. */
export type DiagnosticBillingEventInput = Extract<BillingEventInput, { type: DiagnosticBillingEventType }>;

const ACTOR_TYPE = {
  system: 'SYSTEM',
  operator: 'OPERATOR',
  end_user: 'END_USER',
  provider: 'PROVIDER',
} as const;

/**
 * Validate an event against the union. Throws `BILLING_EVENT_INVALID` naming
 * the first field at fault; a caller that must not fail uses
 * `recordDiagnosticBillingEvent`.
 *
 * @example
 * const event = parseBillingEvent({ type: 'checkout.refused', applicationId, actor: { type: 'system' },
 *   data: { planSlug: 'pro', code: 'BILLING_NO_PROVIDER_FOR_CURRENCY', requestedCurrency: 'INR',
 *           buyerCountry: 'IN', buyerCountrySource: 'hint' } });
 */
export function parseBillingEvent(input: BillingEventInput | BillingEvent): BillingEvent {
  const occurredAt = input.occurredAt instanceof Date ? input.occurredAt.toISOString() : input.occurredAt;
  const { occurredAt: _dropped, ...rest } = input;
  const parsed = BillingEventSchema.safeParse(occurredAt === undefined ? rest : { ...rest, occurredAt });
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const at = issue === undefined || issue.path.length === 0 ? 'the event' : `\`${issue.path.join('.')}\``;
  throw new RekeyError({
    statusCode: 500,
    code: 'BILLING_EVENT_INVALID',
    message: `A "${String(input.type)}" billing event was refused at ${at}: ${issue?.message ?? 'it does not match its schema'}.`,
    fix: 'Send the fields `BillingEventSchema` in @rekey.dev/shared-types declares for this type and no others. A person is named by id: an event never carries an email address, an IP address or a user agent.',
  });
}

/** The id of the thing an event is about, most specific first. */
function subjectOf(event: BillingEvent): string {
  const data = event.data as { unappliedPaymentId?: unknown };
  return (
    event.refundId ??
    event.paymentId ??
    (typeof data.unappliedPaymentId === 'string' ? data.unappliedPaymentId : undefined) ??
    event.subscriptionId ??
    event.checkoutSessionId ??
    event.couponId ??
    ''
  );
}

/**
 * The key a redelivered provider event collapses on when the writer named
 * none: the provider's event id with the type and the thing the event is
 * about. The event id alone is not enough: one Stripe event can carry two
 * refunds, and two unapplied-payment cases can come from one event.
 *
 * @example
 * providerDedupeKey(event); // 'payment.refunded:evt_1:re_2', or null with no provider event id
 */
export function providerDedupeKey(event: BillingEvent): string | null {
  if (event.providerEventId === undefined) return null;
  return `${event.type}:${event.providerEventId}:${subjectOf(event)}`.slice(0, 255);
}

/**
 * The `billing_events` row for a validated event. `fallbackKey` is the dedupe
 * key used when the writer named none and no provider event id gives one.
 *
 * @example
 * await tx.billingEvent.createMany({ data: [toBillingEventRow(event)], skipDuplicates: true });
 */
export function toBillingEventRow(event: BillingEvent, fallbackKey?: string): Prisma.BillingEventCreateManyInput {
  return {
    applicationId: event.applicationId,
    type: event.type,
    tier: BILLING_EVENT_TIER[event.type as BillingEventType],
    occurredAt: event.occurredAt === undefined ? new Date() : new Date(event.occurredAt),
    dedupeKey: event.dedupeKey ?? providerDedupeKey(event) ?? fallbackKey ?? randomUUID(),
    actorType: ACTOR_TYPE[event.actor.type],
    actorId: event.actor.id ?? null,
    endUserId: event.endUserId ?? null,
    subscriptionId: event.subscriptionId ?? null,
    checkoutSessionId: event.checkoutSessionId ?? null,
    paymentId: event.paymentId ?? null,
    refundId: event.refundId ?? null,
    planId: event.planId ?? null,
    planPriceId: event.planPriceId ?? null,
    couponId: event.couponId ?? null,
    provider: event.provider ?? null,
    providerEventId: event.providerEventId ?? null,
    currency: event.currency ?? null,
    amount: event.amount ?? null,
    data: event.data,
  };
}

/** A stored billing event as it leaves the API: `seq` as a string, dates as ISO 8601. */
export type BillingEventRecord = Omit<BillingEventRow, 'seq' | 'occurredAt' | 'recordedAt'> & {
  /** The ordering cursor. A string, because it is a 64-bit integer and JSON has none. */
  seq: string;
  occurredAt: string;
  recordedAt: string;
};

/**
 * A stored event in a shape JSON can carry. `seq` is a BigInt in the row, and
 * `JSON.stringify` throws on one.
 *
 * @example
 * return { success: true, data: rows.map(serializeBillingEvent) };
 */
export function serializeBillingEvent(row: BillingEventRow): BillingEventRecord {
  return {
    ...row,
    seq: row.seq.toString(),
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
  };
}
