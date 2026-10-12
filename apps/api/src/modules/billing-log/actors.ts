/**
 * Who the ids on a page of the billing log are: the end users and operators
 * its entries name, looked up when the page is read.
 *
 * Nothing here is written to the log. An event stores ids only, so that
 * erasing an end user leaves no email behind in it.
 */

import type { BillingLogActors, BillingLogEndUser, BillingLogEntry, BillingLogOperator } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';

function distinct(ids: ReadonlyArray<string | null>): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

async function endUsersOf(applicationId: string, ids: readonly string[]): Promise<BillingLogEndUser[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.endUser.findMany({
    where: { applicationId, id: { in: [...ids] } },
    select: { id: true, email: true, erasedAt: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (row === undefined) return { id, state: 'unknown', email: null };
    // An erased row keeps a placeholder address. It is not the person's email.
    if (row.erasedAt !== null) return { id, state: 'erased', email: null };
    return { id, state: 'known', email: row.email };
  });
}

async function operatorsOf(ids: readonly string[]): Promise<BillingLogOperator[]> {
  if (ids.length === 0) return [];
  // By account, not by membership: an operator who has left the workspace is
  // still the one who made the change.
  const rows = await prisma.tenantUser.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, email: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    return row === undefined
      ? { id, state: 'unknown', name: null, email: null }
      : { id, state: 'known', name: row.name, email: row.email };
  });
}

/**
 * Resolve the people one page of entries names: at most one query for end
 * users and one for operators, whatever the page size.
 *
 * `mayReadEndUsers` is whether the caller holds `end-users:read` on the
 * Application. Without it no end user is looked up and `endUsers` is null.
 *
 * @example
 * const actors = await resolveBillingLogActors(applicationId, page.items, { mayReadEndUsers: true });
 * actors.endUsers?.[0]; // { id: 'eu_1', state: 'known', email: 'buyer@example.com' }
 */
export async function resolveBillingLogActors(
  applicationId: string,
  entries: readonly BillingLogEntry[],
  caller: { mayReadEndUsers: boolean },
): Promise<BillingLogActors> {
  const endUserIds = distinct(
    entries.flatMap((entry) => [entry.endUserId, entry.actor.type === 'end_user' ? entry.actor.id : null]),
  );
  const operatorIds = distinct(entries.map((entry) => (entry.actor.type === 'operator' ? entry.actor.id : null)));
  const [endUsers, operators] = await Promise.all([
    caller.mayReadEndUsers ? endUsersOf(applicationId, endUserIds) : null,
    operatorsOf(operatorIds),
  ]);
  return { endUsers, operators };
}
