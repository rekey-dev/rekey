/**
 * Leaving notification email: one-click unsubscribe and the opt-out record it
 * shares with the email-preferences API.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { suppressionCovers } from '../send-policy.js';
import { enqueueEvent, kickDeliveries } from '../../webhooks/webhook.service.js';
import { verifyUnsubscribeToken, type UnsubscribeTarget } from './unsubscribe-token.js';

export interface UnsubscribeView extends UnsubscribeTarget {
  applicationName: string;
}

/** `topic`: leave the topic the token names. `all`: leave every notification email. */
export type UnsubscribeScope = 'topic' | 'all';

/** The token's target and its Application's name, or null for a token that does not check out. */
export async function describeUnsubscribe(token: string): Promise<UnsubscribeView | null> {
  const target = verifyUnsubscribeToken(token);
  if (!target) return null;
  const application = await prisma.application.findUnique({
    where: { id: target.applicationId },
    select: { name: true },
  });
  return application ? { ...target, applicationName: application.name } : null;
}

type Tx = Prisma.TransactionClient;

/**
 * Inside `tx`, record that `address` left one topic, or every notification
 * email when `topic` is undefined, and queue `email.unsubscribed` when that
 * changed what they receive. An existing suppression row is left as it is: it
 * is either this same opt-out or a broader entry (a bounce, a complaint, an
 * operator's), and narrowing a broader one would resume mail the operator
 * stopped. Returns the deliveries to kick after commit.
 */
export async function optOutIn(tx: Tx, applicationId: string, address: string, topic?: string): Promise<string[]> {
  if (topic === undefined) {
    const { count } = await tx.emailSuppression.createMany({
      data: [{ applicationId, address, reason: 'unsubscribe', category: 'notification', createdBy: null }],
      skipDuplicates: true,
    });
    if (count === 0) return [];
  } else {
    const { count } = await tx.emailTopicOptOut.createMany({ data: [{ applicationId, address, topic }], skipDuplicates: true });
    if (count === 0) return [];
    const broader = await tx.emailSuppression.findUnique({
      where: { applicationId_address: { applicationId, address } },
      select: { category: true },
    });
    if (broader !== null && suppressionCovers(broader.category, 'notification')) return [];
  }
  const endUser = await tx.endUser.findUnique({
    where: { applicationId_email: { applicationId, email: address } },
    select: { id: true },
  });
  return enqueueEvent(tx, {
    applicationId,
    type: 'email.unsubscribed',
    data: {
      address,
      ...(endUser !== null && { endUserId: endUser.id }),
      category: 'notification',
      ...(topic !== undefined && { topic }),
    },
  });
}

/**
 * {@link optOutIn} in a transaction of its own.
 *
 * @example
 * ```ts
 * await recordOptOut(application.id, 'a@example.com', 'onboarding');
 * ```
 */
export async function recordOptOut(applicationId: string, rawAddress: string, topic?: string): Promise<void> {
  const address = rawAddress.trim().toLowerCase();
  const deliveryIds = await prisma.$transaction((tx) => optOutIn(tx, applicationId, address, topic));
  kickDeliveries(deliveryIds);
}

/** Act on a one-click token. A token without a topic always leaves every notification email. */
export async function unsubscribe(token: string, scope: UnsubscribeScope = 'topic'): Promise<UnsubscribeView | null> {
  const view = await describeUnsubscribe(token);
  if (!view) return null;
  await recordOptOut(view.applicationId, view.address, scope === 'topic' ? view.topic : undefined);
  return view;
}
