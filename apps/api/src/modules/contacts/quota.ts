/**
 * Workspace ceilings on lists and contacts (`Tenant.limits`, see
 * lib/tenant-limits.ts). Null or absent means unlimited, which is every
 * self-hosted workspace.
 */

import type { Prisma } from '@prisma/client';
import { parseTenantLimits } from '../../lib/tenant-limits.js';
import { listQuotaExceeded } from './errors.js';

type Db = Prisma.TransactionClient;

export function countLiveContactLists(tenantId: string, db: Db): Promise<number> {
  return db.contactList.count({ where: { archivedAt: null, application: { tenantId } } });
}

export function countContacts(tenantId: string, db: Db): Promise<number> {
  return db.contact.count({ where: { application: { tenantId } } });
}

/**
 * Throw `CONTACT_LIST_QUOTA_EXCEEDED` when the workspace has no room for one
 * more live list. Takes a per-workspace transaction lock first: lists are
 * created a handful of times, so serialising them costs nothing and the
 * ceiling holds exactly.
 */
export async function assertContactListQuota(tenantId: string, tx: Db): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contact_lists:${tenantId}`}))`;
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { limits: true } });
  const max = parseTenantLimits(tenant?.limits).maxContactLists;
  if (max === null || max === undefined) return;
  const current = await countLiveContactLists(tenantId, tx);
  if (current >= max) throw listQuotaExceeded(max, current);
}
