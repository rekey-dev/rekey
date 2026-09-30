import type { Prisma } from '@prisma/client';

export type EndUserListSort = 'createdAt' | 'email' | 'lastSignedInAt' | 'lastActiveOn';

/**
 * The primary `orderBy` of the operator end-user list. Users who never signed
 * in (or were never active) sort last under `lastSignedInAt` and
 * `lastActiveOn` in both directions, so "most recent" and "longest ago" both
 * open on people who did.
 *
 * @example
 *   prisma.endUser.findMany({ orderBy: [endUserListOrder('lastSignedInAt', 'desc'), { id: 'desc' }] });
 */
export function endUserListOrder(
  sort: EndUserListSort | undefined,
  order: Prisma.SortOrder,
): Prisma.EndUserOrderByWithRelationInput {
  if (sort === 'email') return { email: order };
  if (sort === 'lastSignedInAt') return { lastSignedInAt: { sort: order, nulls: 'last' } };
  if (sort === 'lastActiveOn') return { lastActiveOn: { sort: order, nulls: 'last' } };
  return { createdAt: order };
}
