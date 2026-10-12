/**
 * The two ledgers that make a free plan claimable once: `FreeTierClaim`, one
 * per person and plan, and `OrganizationFreeTierClaim`, one per organization
 * and plan. Each is settled under an advisory lock, inside the transaction
 * that writes the subscription the claim is for.
 */

import type { Prisma, Subscription } from '@prisma/client';
import { ENTITLING_SUBSCRIPTION_STATUSES } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';

/**
 * Decide a free-tier claim, and return what records it once the activation is
 * written. Throws when the actor already claimed the plan for somebody else.
 *
 * The advisory lock is keyed on the claim's own identity, so concurrent
 * activations by one actor serialise here and the second reads the first's
 * committed row. The unique key on `free_tier_claims` is the backstop: were
 * the lock ever lost, the second insert fails P2002 and the whole activation
 * rolls back with it.
 *
 * Same beneficiary returns a recorder that writes nothing: the claim already
 * exists, and a reactivation for it issues nothing new because the credit
 * anchor (`'initial'` for an open-ended grant) and the per-pool licence lookup
 * in `entitlementsService.provision` both collide.
 *
 * @example
 * const record = await settleFreeTierClaim(tx, { applicationId, endUserId, planId, planSlug: 'free', organizationId: null });
 * await record(subscription.id);
 */
export async function settleFreeTierClaim(
  tx: Prisma.TransactionClient,
  args: {
    applicationId: string;
    endUserId: string;
    planId: string;
    planSlug: string;
    organizationId: string | null;
  },
): Promise<(subscriptionId: string) => Promise<void>> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rekey:free-tier:${args.applicationId}:${args.endUserId}:${args.planId}`}, 0))`;
  const prior = await tx.freeTierClaim.findUnique({
    where: {
      applicationId_endUserId_planId: {
        applicationId: args.applicationId,
        endUserId: args.endUserId,
        planId: args.planId,
      },
    },
    select: { organizationId: true },
  });
  if (prior) {
    if (prior.organizationId !== args.organizationId) {
      const holder = prior.organizationId ? 'an organization' : 'your personal account';
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_FREE_TIER_ALREADY_CLAIMED',
        message:
          `The free plan "${args.planSlug}" grants credits or a licence, and you already claimed it ` +
          `for ${holder}. It can be claimed once per person.`,
        fix:
          'An operator can grant the plan to this beneficiary, or the buyer can purchase a plan for ' +
          'it through POST /api/v1/billing/checkout. Reactivating it for the beneficiary that ' +
          'already holds the claim is allowed.',
      });
    }
    return async () => {};
  }
  return async (subscriptionId) => {
    await tx.freeTierClaim.create({
      data: {
        applicationId: args.applicationId,
        endUserId: args.endUserId,
        planId: args.planId,
        organizationId: args.organizationId,
        subscriptionId,
      },
    });
  };
}

/**
 * The subscriber's live subscription to this plan is billed to a different
 * subject. A subscription to one plan is one row per subscriber (#431), so
 * granting it for another subject would move it, the refusal hosted checkout
 * makes with the same code.
 */
/**
 * Another admin's live free row for this organization, read under a lock held
 * until the grant transaction ends. Without the lock, admins racing for one
 * organization each saw no row and each got one, doubling its included usage
 * and, for a credit plan, granting the pool twice. The lock is per
 * (application, organization, plan), unlike the per-end-user claim lock.
 *
 * @example
 * const held = await organizationFreeRowUnderLock(tx, applicationId, organizationId, planId, endUserId);
 */
export async function organizationFreeRowUnderLock(
  tx: Prisma.TransactionClient,
  applicationId: string,
  organizationId: string,
  planId: string,
  endUserId: string,
): Promise<Subscription | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`free-tier-org:${applicationId}:${organizationId}:${planId}`}, 0))`;
  return tx.subscription.findFirst({
    where: {
      applicationId,
      planId,
      beneficiaryOrgId: organizationId,
      endUserId: { not: endUserId },
      status: { in: [...ENTITLING_SUBSCRIPTION_STATUSES] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/**
 * Record that an organization is on the free tier. Idempotent under any number
 * of concurrent claims: the unique key settles it and a duplicate is skipped.
 *
 * @example
 * await recordOrganizationClaim(applicationId, organizationId, planId, endUserId);
 */
export async function recordOrganizationClaim(
  applicationId: string,
  organizationId: string,
  planId: string,
  claimedByEndUserId: string,
): Promise<void> {
  await prisma.organizationFreeTierClaim.createMany({
    data: [{ applicationId, organizationId, planId, claimedByEndUserId }],
    skipDuplicates: true,
  });
}
