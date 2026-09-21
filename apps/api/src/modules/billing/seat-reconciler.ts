/**
 * Make a seat count that was SOLD actually reach the licence (#488).
 *
 * `PATCH .../entitlement-overrides` with `{"LICENSE:<key>": 50}` returned 200,
 * echoed `quantity: 50` and emitted `subscription.entitlements_updated`, while
 * the licence went on refusing activations past the number it was issued with.
 * The buyer paid for fifty seats and had five, and nothing reported the
 * disagreement.
 *
 * Three things made a one-line fix wrong, and this module exists to hold all
 * three at once:
 *
 *   1. The override write path never provisions. `patch` updates, resolves,
 *      enqueues and returns. A reconciliation living in `provision` would run
 *      at the next provider webhook at the earliest, and `grant.service`
 *      returns early when the subscription is already entitling, so a
 *      PROVIDER-LESS subscription would never re-provision at all. That is
 *      every Rekey Cloud subscription, since checkout is disabled there.
 *   2. One org-pooled licence, many subscriptions. `Subscription` is unique on
 *      `(applicationId, endUserId, planId)`, so two owners can each hold a
 *      subscription on the same plan with the same `beneficiaryOrgId`, and both
 *      resolve to the same pooled licence. Writing "this subscription's
 *      quantity" would let Bob's unrelated renewal reset Alice's negotiated 50
 *      to the plan's 5, with no event and no log line.
 *   3. Two LICENSE rows on one plan used to resolve to one licence. Fixed by
 *      `License.entitlementKey`; this module keys on it for the same reason.
 *
 * So: reconcile toward the MAXIMUM across the entitling subscriptions targeting
 * that pool, keyed on the entitlement, triggered from the write path.
 *
 * Lowering a seat count does NOT revoke activations already in use.
 * `licenses.service` refuses the next activation past the ceiling, which is the
 * right direction; pulling a running machine's seat mid-period is not something
 * a quantity edit should do silently.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { ENTITLING_SUBSCRIPTION_STATUSES } from '@rekey.dev/shared-types';
import { applyOverrides, entitlementsService } from './entitlements.service.js';

/** The licence pool a seat count belongs to. */
export interface SeatPool {
  applicationId: string;
  planId: string;
  entitlementKey: string;
  /** Org pool, or null for a personal licence. */
  organizationId: string | null;
  /** Owner, for the personal case. Ignored when `organizationId` is set. */
  endUserId: string | null;
}

/**
 * Recompute one pool's seat ceiling from every subscription that funds it.
 *
 * Never throws. It is called after the override has already committed, and a
 * bookkeeping write must not be able to fail the write that triggered it, the
 * same rule the webhook appliers state. A failure leaves the licence at its
 * previous ceiling, which is the pre-existing behaviour rather than a new one.
 */
export async function reconcileSeatsForPool(
  pool: SeatPool,
  log?: { warn: (obj: unknown, msg: string) => void; info?: (obj: unknown, msg: string) => void },
): Promise<{ reconciled: boolean; seatsAllowed?: number }> {
  try {
    const subjectWhere: Prisma.SubscriptionWhereInput = pool.organizationId
      ? { beneficiaryOrgId: pool.organizationId }
      : { endUserId: pool.endUserId ?? '', beneficiaryOrgId: null };

    const subs = await prisma.subscription.findMany({
      where: {
        applicationId: pool.applicationId,
        planId: pool.planId,
        status: { in: [...ENTITLING_SUBSCRIPTION_STATUSES] },
        ...subjectWhere,
      },
      select: { id: true, planId: true, entitlementOverrides: true },
    });
    if (subs.length === 0) return { reconciled: false };

    const plan = await prisma.plan.findUnique({ where: { id: pool.planId } });
    if (!plan) return { reconciled: false };
    const planRows = await entitlementsService.resolveForPlan(plan);

    // MAX, not last-writer. Two subscriptions can fund one org pool, and a
    // renewal on either must not lower a ceiling negotiated on the other.
    let ceiling: number | null = null;
    for (const s of subs) {
      for (const e of applyOverrides(planRows, s.entitlementOverrides)) {
        if (e.kind !== 'LICENSE' || e.key !== pool.entitlementKey) continue;
        if (e.licenseKind !== 'SEATS') continue;
        if (e.quantity == null || !Number.isFinite(e.quantity) || e.quantity < 1) continue;
        ceiling = ceiling === null ? e.quantity : Math.max(ceiling, e.quantity);
      }
    }
    if (ceiling === null) return { reconciled: false };

    const licence = await prisma.license.findFirst({
      where: {
        applicationId: pool.applicationId,
        planId: pool.planId,
        entitlementKey: pool.entitlementKey,
        kind: 'SEATS',
        revokedAt: null,
        ...(pool.organizationId
          ? { organizationId: pool.organizationId }
          : { endUserId: pool.endUserId ?? '', organizationId: null }),
      },
      select: { id: true, seatsAllowed: true },
    });
    // No licence yet means nothing has been issued for this pool. `provision`
    // issues it with the resolved seat count when it runs, so there is nothing
    // to correct here and creating one would issue a key nobody asked for.
    if (!licence) return { reconciled: false };
    if (licence.seatsAllowed === ceiling) return { reconciled: false, seatsAllowed: ceiling };

    await prisma.license.update({ where: { id: licence.id }, data: { seatsAllowed: ceiling } });
    log?.info?.(
      { licenseId: licence.id, from: licence.seatsAllowed, to: ceiling },
      'seat ceiling reconciled from entitlement overrides',
    );
    return { reconciled: true, seatsAllowed: ceiling };
  } catch (err) {
    log?.warn({ err, pool }, 'seat reconciliation failed; licence keeps its previous ceiling');
    return { reconciled: false };
  }
}

/**
 * Reconcile every SEATS pool a subscription funds.
 *
 * Called post-commit from the override write path. Reads the subscription
 * fresh, so it sees the override that was just written.
 */
export async function reconcileSeatsForSubscription(
  subscriptionId: string,
  log?: { warn: (obj: unknown, msg: string) => void; info?: (obj: unknown, msg: string) => void },
): Promise<void> {
  try {
    const sub = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        applicationId: true,
        planId: true,
        endUserId: true,
        beneficiaryOrgId: true,
        entitlementOverrides: true,
      },
    });
    if (!sub) return;

    const plan = await prisma.plan.findUnique({ where: { id: sub.planId } });
    if (!plan) return;

    const keys = new Set<string>();
    for (const e of applyOverrides(await entitlementsService.resolveForPlan(plan), sub.entitlementOverrides)) {
      if (e.kind === 'LICENSE' && e.licenseKind === 'SEATS') keys.add(e.key);
    }

    for (const entitlementKey of keys) {
      await reconcileSeatsForPool(
        {
          applicationId: sub.applicationId,
          planId: sub.planId,
          entitlementKey,
          organizationId: sub.beneficiaryOrgId,
          endUserId: sub.endUserId,
        },
        log,
      );
    }
  } catch (err) {
    log?.warn({ err, subscriptionId }, 'seat reconciliation failed; licence keeps its previous ceiling');
  }
}
