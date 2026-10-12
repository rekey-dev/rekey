/**
 * The rules an externally sold subscription (`subscription.granted`) is judged
 * by before anything is written, and the two writes that record a refusal or
 * retire the row a subscription id used to name.
 */

import type { Subscription } from '@prisma/client';
import { isEntitlingStatus } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { dunningService } from '../dunning.service.js';
import { kickDeliveries } from '../../webhooks/webhook.service.js';
import { enqueueSubscriptionEvent } from './billing-events.js';
import { logSubscriptionCanceled } from '../money-events.js';
import type { SubscriptionGrantedEvent, SubscriptionStatusEvent } from '../providers/module-types.js';
import { TERMINAL_STATUSES, metadataObject, type ApplyContext } from './apply-shared.js';

/**
 * How far a period end must move forward to count as a new period.
 *
 * Provisioning anchors credits and a timed licence on `currentPeriodEnd`, so
 * any forward move is a refill. A sender restating the same period with an end
 * a few seconds later is not a renewal, and minted a second period's credits.
 * The shortest plan interval is a month, so a day separates a restatement from
 * a renewal with room on both sides. A smaller move leaves the period as it is.
 */
export const MIN_RENEWAL_ADVANCE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a live row for this subscriber and plan is billed to a different
 * subject than the event names.
 *
 * The row is unique on (application, end-user, plan), so the same buyer
 * holding one plan for two organizations is one row. Writing the second
 * activation onto it moved the first organization's subscription and its id,
 * after which the first organization's cancellation matched nothing. Hosted
 * checkout refuses the same move with BILLING_SUBSCRIPTION_SUBJECT_CONFLICT.
 *
 * Never on the row's own subscription id. That event is a renewal or recovery
 * of the subscription the row already is; refusing it is acknowledged with a
 * 200 and lost for good, leaving a paid subscription unrefilled and in
 * dunning. It applies and keeps the row's beneficiary (see
 * `ignoredSubjectChange`). A different subscription id is a second sale, so
 * its subject is compared as given, an omitted organization counting as the
 * personal account.
 */
export function holdsAnotherSubject(existing: Subscription, ev: SubscriptionGrantedEvent): boolean {
  if (!isEntitlingStatus(existing.status)) return false;
  if (existing.providerSubId === ev.providerSubscriptionId) return false;
  return existing.beneficiaryOrgId !== (ev.organizationId ?? null);
}

/** A same-id event naming an organization the live row is not billed to. */
export function ignoredSubjectChange(existing: Subscription, ev: SubscriptionGrantedEvent): boolean {
  return (
    existing.providerSubId === ev.providerSubscriptionId &&
    ev.organizationId !== undefined &&
    existing.beneficiaryOrgId !== ev.organizationId
  );
}

/**
 * The organization an event keeps when it omits one: the beneficiary of the
 * row already bound to its subscription id, for the same plan and subscriber.
 * Null when the id is new, or names another plan, provider or subscriber;
 * those are new sales and must name their organization.
 *
 * Without this an org-billed Application refused every renewal that did not
 * repeat `subscriber.organizationId`, and each retry failed the same way.
 */
export async function organizationKeptBy(
  holder: Subscription | null,
  planId: string,
  ev: SubscriptionGrantedEvent,
): Promise<string | null> {
  if (!holder || holder.beneficiaryOrgId === null || holder.planId !== planId) return null;
  if (holder.provider !== null && holder.provider !== ev.provider) return null;
  const endUserId =
    'endUserId' in ev.subscriber
      ? ev.subscriber.endUserId
      : (
          await prisma.endUser.findUnique({
            where: {
              applicationId_email: { applicationId: ev.applicationId, email: ev.subscriber.email.toLowerCase() },
            },
            select: { id: true },
          })
        )?.id;
  return endUserId === holder.endUserId ? holder.beneficiaryOrgId : null;
}

/**
 * How far ahead of Rekey's clock a sender's `occurredAt` may run and still be
 * trusted. A few minutes covers ordinary clock drift; a date beyond it is a
 * bug in the sender, and trusted it would date a cancellation in the future
 * and refuse every genuine reactivation until then.
 */
const SENDER_CLOCK_SKEW_MS = 5 * 60 * 1000;

function beyondSenderSkew(at: Date, now: Date): boolean {
  return at.getTime() > now.getTime() + SENDER_CLOCK_SKEW_MS;
}

/** An activation whose `occurredAt` is too far ahead is treated as undated. */
export function withSenderClockChecked(
  ev: SubscriptionGrantedEvent,
  now: Date,
  ctx: ApplyContext,
): SubscriptionGrantedEvent {
  if (ev.occurredAt === undefined || !beyondSenderSkew(ev.occurredAt, now)) return ev;
  ctx.note?.(senderClockNote(ev.occurredAt, 'activation'));
  const { occurredAt: _ignored, ...undated } = ev;
  return undated;
}

/** A cancellation the sender dated too far ahead is dated by Rekey's clock. */
export function withSenderCancelDateChecked(
  ev: SubscriptionStatusEvent,
  now: Date,
  ctx: ApplyContext,
): SubscriptionStatusEvent {
  if (ev.canceledAtFromSender !== true || !(ev.canceledAt instanceof Date) || !beyondSenderSkew(ev.canceledAt, now)) {
    return ev;
  }
  ctx.note?.(senderClockNote(ev.canceledAt, 'cancellation'));
  return { ...ev, canceledAt: now, cancelAt: now, canceledAtFromSender: false };
}

function senderClockNote(at: Date, what: 'activation' | 'cancellation'): string {
  return (
    `occurredAt ${at.toISOString()} is more than 5 minutes ahead of Rekey's clock, so it was ignored and ` +
    `the ${what} was dated by Rekey's clock instead. Check the clock of the system sending these events.`
  );
}

/**
 * Whether this activation is older news than the cancellation already applied
 * to the same subscription id. `transitionAllowed` keeps a stale status event
 * from reopening a terminal row; an activation reaches the grant path instead,
 * which does reopen, so it needs its own clock check.
 *
 * Only against a cancellation the SENDER dated (`metadata.senderCanceledAt`,
 * still equal to `canceledAt`, so it is this cancellation and not an earlier
 * one). A `canceledAt` from Rekey's own clock is not comparable with the
 * sender's `occurredAt`: a sender a few seconds behind would have its genuine
 * reactivation refused.
 */
export function predatesCancellation(existing: Subscription, ev: SubscriptionGrantedEvent): boolean {
  const senderCanceledAt = metadataObject(existing.metadata).senderCanceledAt;
  return (
    TERMINAL_STATUSES.has(existing.status) &&
    existing.providerSubId === ev.providerSubscriptionId &&
    ev.occurredAt !== undefined &&
    existing.canceledAt !== null &&
    senderCanceledAt === existing.canceledAt.toISOString() &&
    ev.occurredAt <= existing.canceledAt
  );
}


/** Keep the last twenty refused activations on the row for the operator. */
export async function recordRefusedGrant(
  row: Subscription,
  ev: SubscriptionGrantedEvent,
  now: Date,
): Promise<void> {
  const previous =
    typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  const refused = Array.isArray(previous.refusedGrants) ? previous.refusedGrants.slice(-19) : [];
  await prisma.subscription.update({
    where: { id: row.id },
    data: {
      metadata: {
        ...previous,
        refusedGrants: [
          ...refused,
          {
            provider: ev.provider,
            providerSubId: ev.providerSubscriptionId,
            providerEventId: ev.providerEventId,
            at: now.toISOString(),
          },
        ],
      } as never,
    },
  });
}

/**
 * The sender's subscription id was bound to a row this event does not
 * describe. Release the id and, if that row was live, cancel it: the
 * external system has said the subscription now buys a different plan, or
 * belongs to a different account. Announced as a cancellation because that
 * is what happened to THAT row; the activation of its replacement follows
 * from the caller.
 */
export async function retireReplacedSubscription(
  holder: Subscription,
  ev: SubscriptionGrantedEvent,
  ctx: ApplyContext,
): Promise<void> {
  const now = new Date();
  const wasEntitled = isEntitlingStatus(holder.status);
  const previous =
    typeof holder.metadata === 'object' && holder.metadata !== null && !Array.isArray(holder.metadata)
      ? (holder.metadata as Record<string, unknown>)
      : {};
  const deliveryIds = await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: holder.id },
      data: {
        providerSubId: null,
        ...(wasEntitled && { status: 'CANCELED' as const, cancelAt: now, canceledAt: now }),
        metadata: {
          ...previous,
          replacedBy: {
            providerSubId: ev.providerSubscriptionId,
            planSlug: ev.planSlug,
            providerEventId: ev.providerEventId,
            at: now.toISOString(),
          },
        } as never,
      },
    });
    if (!wasEntitled) return [];
    await logSubscriptionCanceled(
      tx,
      holder.id,
      { atPeriodEnd: false, cause: 'provider' },
      { actor: { type: 'provider', id: ev.provider }, provider: ev.provider, providerEventId: ev.providerEventId, log: ctx.log },
    );
    return enqueueSubscriptionEvent(tx, 'subscription.canceled', holder.id);
  });
  kickDeliveries(deliveryIds);
  if (wasEntitled) await dunningService.closeForCanceledSubscription(holder.id);
  ctx.log.info(
    {
      subscriptionId: holder.id,
      previousPlanId: holder.planId,
      previousEndUserId: holder.endUserId,
      providerSubscriptionId: ev.providerSubscriptionId,
      providerEventId: ev.providerEventId,
    },
    wasEntitled
      ? 'subscription.granted, retired the row previously bound to this subscription id'
      : 'subscription.granted, released the subscription id from a dormant row',
  );
}
