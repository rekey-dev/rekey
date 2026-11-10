/**
 * Giving a licence seat back. Shared by every path that frees one, so they
 * apply one policy and send one webhook.
 */

import type { License } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { enqueueEvent, kickDeliveries } from '../webhooks/webhook.service.js';

/** Why a licence can no longer give a seat back, or null when it can. */
export function inactiveReason(license: License): 'revoked' | 'expired' | null {
  if (license.status === 'REVOKED' || license.revokedAt !== null) return 'revoked';
  if (license.expiresAt !== null && license.expiresAt <= new Date()) return 'expired';
  return null;
}

/**
 * Release the one live activation `where` names and announce it. Every path
 * that gives a seat back (the client's own deactivate, the holder from their
 * account) goes through here, so they share one policy and one webhook.
 */
export async function releaseSeat(
  license: License,
  where: { machineFingerprint: string } | { id: string },
  releasedBy: 'client' | 'end_user',
): Promise<boolean> {
  const { released, deliveryIds } = await prisma.$transaction(async (tx) => {
    const live = await tx.licenseActivation.findFirst({ where: { licenseId: license.id, releasedAt: null, ...where } });
    if (!live) return { released: false, deliveryIds: [] };
    const updated = await tx.licenseActivation.updateMany({
      where: { id: live.id, releasedAt: null },
      data: { releasedAt: new Date() },
    });
    if (updated.count !== 1) return { released: false, deliveryIds: [] };
    const ids = await enqueueEvent(tx, {
      applicationId: license.applicationId,
      type: 'license.deactivated',
      data: {
        license: { id: license.id, endUserId: license.endUserId, kind: license.kind },
        machineFingerprint: live.machineFingerprint,
        releasedBy,
      },
    });
    return { released: true, deliveryIds: ids };
  });
  kickDeliveries(deliveryIds);
  return released;
}
