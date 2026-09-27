/**
 * The two trial webhooks.
 *
 * `subscription.trial_started` is written by whichever write moved the row
 * into TRIALING, through that write's transaction: a grant, a hosted checkout
 * completing on a trial, or a provider's status mirror.
 *
 * `subscription.trial_will_end` has no write to ride on, the news is that time
 * passed. A sweep on the dunning poller's pattern finds TRIALING rows whose
 * trial ends within `TRIAL_WILL_END_LEAD_DAYS` and claims each one by moving
 * `trialWillEndNotifiedFor` to its current `trialEndsAt`, in the same
 * transaction as the delivery row. The claim is conditional, so concurrent
 * sweeps on several replicas announce a (subscription, trial end) pair once; a
 * failed enqueue rolls the claim back for the next sweep; and a re-dated trial
 * no longer matches its old claim and is announced again for the new end.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { Prisma, Subscription } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { kickDeliveries } from '../webhooks/webhook.service.js';
import { enqueueSubscriptionEvent } from './webhooks/billing-events.js';

/** How far ahead of the trial end `subscription.trial_will_end` is sent. */
export const TRIAL_WILL_END_LEAD_DAYS = 3;

const DAY_MS = 86_400_000;

/**
 * Enqueue what a subscription becoming live announces: `subscription.activated`,
 * plus `subscription.trial_started` when it went live on a trial. Call only on
 * a real transition into a live status, through the transaction that made it.
 *
 * @example
 *   deliveryIds = await enqueueActivation(tx, row);
 */
export async function enqueueActivation(
  tx: Prisma.TransactionClient,
  sub: Pick<Subscription, 'id' | 'status'>,
): Promise<string[]> {
  const ids = await enqueueSubscriptionEvent(tx, 'subscription.activated', sub.id);
  if (sub.status !== 'TRIALING') return ids;
  return [...ids, ...(await enqueueSubscriptionEvent(tx, 'subscription.trial_started', sub.id))];
}

/**
 * Announce every TRIALING subscription whose trial ends within the lead time
 * and has not been announced for that end date. Returns how many it announced.
 * Registered on an interval in app.ts; safe to run concurrently.
 *
 * @example
 *   await processTrialsEndingSoon(100, app.log);
 */
export async function processTrialsEndingSoon(limit = 100, log?: FastifyBaseLogger): Promise<number> {
  const now = new Date();
  const horizon = new Date(now.getTime() + TRIAL_WILL_END_LEAD_DAYS * DAY_MS);
  const due = await prisma.$queryRaw<Array<{ id: string; trialEndsAt: Date }>>`
    SELECT id, trial_ends_at AS "trialEndsAt"
      FROM subscriptions
     WHERE status = 'TRIALING'
       AND trial_ends_at > ${now}
       AND trial_ends_at <= ${horizon}
       AND trial_will_end_notified_for IS DISTINCT FROM trial_ends_at
     ORDER BY trial_ends_at
     LIMIT ${limit}`;
  let announced = 0;
  for (const row of due) {
    try {
      if (await announceTrialWillEnd(row)) announced += 1;
    } catch (err) {
      log?.warn({ err, subscriptionId: row.id }, 'trial_will_end announcement failed; the next sweep retries it');
    }
  }
  return announced;
}

/**
 * Claim one (subscription, trial end) pair and enqueue its
 * `subscription.trial_will_end`, in one transaction. False when another sweep
 * already claimed it or the row changed since it was read, so a stale read
 * from a concurrent sweep announces nothing.
 *
 * @example
 *   await announceTrialWillEnd({ id: sub.id, trialEndsAt: sub.trialEndsAt });
 */
export async function announceTrialWillEnd(row: { id: string; trialEndsAt: Date }): Promise<boolean> {
  const deliveryIds = await prisma.$transaction(async (tx) => {
    const claimed = await tx.subscription.updateMany({
      where: {
        id: row.id,
        status: 'TRIALING',
        trialEndsAt: row.trialEndsAt,
        OR: [{ trialWillEndNotifiedFor: null }, { trialWillEndNotifiedFor: { not: row.trialEndsAt } }],
      },
      data: { trialWillEndNotifiedFor: row.trialEndsAt },
    });
    if (claimed.count !== 1) return null;
    return enqueueSubscriptionEvent(tx, 'subscription.trial_will_end', row.id);
  });
  if (deliveryIds === null) return false;
  kickDeliveries(deliveryIds);
  return true;
}
