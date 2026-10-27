import type { DunningCaseStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export type DunningSort = 'openedAt' | 'nextActionAt' | 'status';

/**
 * A page of an Application's dunning cases with each end user's email and
 * plan, as the REST list and the operator MCP return them.
 *
 * @example
 *   const { items, total } = await listDunningCases('app_1', { status: 'OPEN', take: 25, skip: 0 });
 */
export async function listDunningCases(
  applicationId: string,
  opts: {
    status?: DunningCaseStatus | undefined;
    subscriptionId?: string | undefined;
    sort?: DunningSort | undefined;
    order?: Prisma.SortOrder | undefined;
    take: number;
    skip: number;
  },
) {
  const order = opts.order ?? 'desc';
  const primaryOrder =
    opts.sort === 'nextActionAt' ? { nextActionAt: order } : opts.sort === 'status' ? { status: order } : { openedAt: order };
  const where = {
    applicationId,
    ...(opts.status && { status: opts.status }),
    ...(opts.subscriptionId && { subscriptionId: opts.subscriptionId }),
  };
  const [cases, total] = await Promise.all([
    prisma.dunningCase.findMany({
      where,
      include: { subscription: { select: { plan: { select: { slug: true, name: true } } } } },
      // Stable secondary order by id so pages never overlap/skip.
      orderBy: [primaryOrder, { id: 'desc' }],
      take: opts.take,
      skip: opts.skip,
    }),
    prisma.dunningCase.count({ where }),
  ]);
  // DunningCase.endUserId is a plain column (like Payment), join the emails
  // with a second bounded query.
  const userIds = [...new Set(cases.map((c) => c.endUserId).filter((v): v is string => v !== null))];
  const users = userIds.length
    ? await prisma.endUser.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
    : [];
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  const items = cases.map((c) => ({
    id: c.id,
    subscriptionId: c.subscriptionId,
    endUserId: c.endUserId,
    endUserEmail: c.endUserId ? (emailById.get(c.endUserId) ?? null) : null,
    organizationId: c.organizationId,
    status: c.status,
    planSlug: c.subscription.plan.slug,
    planName: c.subscription.plan.name,
    failedAttempts: c.failedAttempts,
    remindersSent: c.remindersSent,
    lastFailureAt: c.lastFailureAt?.toISOString() ?? null,
    nextActionAt: c.nextActionAt?.toISOString() ?? null,
    openedAt: c.openedAt.toISOString(),
    closedAt: c.closedAt?.toISOString() ?? null,
  }));
  return { items, total };
}
