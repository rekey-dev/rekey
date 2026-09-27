/**
 * One-click unsubscribe: what a token names, and recording it.
 */

import { prisma } from '../../../lib/prisma.js';
import { verifyUnsubscribeToken, type UnsubscribeTarget } from './unsubscribe-token.js';

export interface UnsubscribeView extends UnsubscribeTarget {
  applicationName: string;
}

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

/**
 * Suppress the address for the token's category only. An existing row is left
 * as it is: it is either this same unsubscribe or a broader entry (a bounce, a
 * complaint, an operator's), and narrowing a broader one would resume mail the
 * operator stopped.
 */
export async function unsubscribe(token: string): Promise<UnsubscribeView | null> {
  const view = await describeUnsubscribe(token);
  if (!view) return null;
  await prisma.emailSuppression.upsert({
    where: { applicationId_address: { applicationId: view.applicationId, address: view.address } },
    create: {
      applicationId: view.applicationId,
      address: view.address,
      reason: 'unsubscribe',
      category: view.category,
      createdBy: null,
    },
    update: {},
  });
  return view;
}
