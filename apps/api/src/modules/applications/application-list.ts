import { Prisma, type Application } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';

export const APPLICATION_LIST_SORTS = ['created', 'name', 'activity'] as const;
export const APPLICATION_LIST_STATUSES = ['active', 'disabled'] as const;

/** The narrowing `GET /api/v1/tenant/applications` accepts on top of pagination. */
export const ApplicationListFilterQuery = z.object({
  status: z.enum(APPLICATION_LIST_STATUSES).optional(),
  environment: z.enum(['PRODUCTION', 'STAGING', 'DEVELOPMENT']).optional(),
  q: z.string().trim().max(80).optional(),
  sort: z.enum(APPLICATION_LIST_SORTS).optional(),
  include: z.literal('summary').optional(),
});
export type ApplicationListFilter = z.infer<typeof ApplicationListFilterQuery>;

/** The rows on which the caller holds one scope. */
export type RowSet = { all: true } | { all: false; ids: string[] };

/**
 * Which parts of a row's activity the caller may read. End-user activity is
 * overview data; a key's last use is developer data, so it counts only where
 * the caller holds both. Sorting by a figure the caller may not see would
 * still disclose it through the order, so the sort uses the same rule.
 */
export interface ActivityVisibility {
  overview: RowSet;
  developer: RowSet;
}

export interface ApplicationSummary {
  /** Keys that authenticate today: not revoked and not expired. Absent without `developer:read`. */
  activeApiKeys?: number;
  /**
   * The last UTC day an end-user was active, or a key was used when the caller
   * also holds `developer:read`. Absent without `overview:read`.
   */
  lastActiveOn?: string | null;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function whereFor(tenantId: string, ids: string[] | undefined, filter: ApplicationListFilter): Prisma.ApplicationWhereInput {
  const term = filter.q ? escapeLike(filter.q) : undefined;
  return {
    tenantId,
    ...(ids !== undefined && { id: { in: ids } }),
    ...(filter.status === 'active' && { disabledAt: null }),
    ...(filter.status === 'disabled' && { disabledAt: { not: null } }),
    ...(filter.environment && { environment: filter.environment }),
    ...(term && {
      OR: [
        { name: { contains: term, mode: 'insensitive' as const } },
        { slug: { contains: term, mode: 'insensitive' as const } },
      ],
    }),
  };
}

function sqlWhere(tenantId: string, ids: string[] | undefined, filter: ApplicationListFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`a.tenant_id = ${tenantId}`];
  if (ids !== undefined) parts.push(ids.length ? Prisma.sql`a.id IN (${Prisma.join(ids)})` : Prisma.sql`false`);
  if (filter.status === 'active') parts.push(Prisma.sql`a.disabled_at IS NULL`);
  if (filter.status === 'disabled') parts.push(Prisma.sql`a.disabled_at IS NOT NULL`);
  if (filter.environment) parts.push(Prisma.sql`a.environment = ${filter.environment}::"AppEnvironment"`);
  if (filter.q) {
    const like = `%${escapeLike(filter.q)}%`;
    parts.push(Prisma.sql`(a.name ILIKE ${like} OR a.slug ILIKE ${like})`);
  }
  return Prisma.join(parts, ' AND ');
}

function inRowSet(set: RowSet): Prisma.Sql {
  if (set.all) return Prisma.sql`true`;
  return set.ids.length ? Prisma.sql`a.id IN (${Prisma.join(set.ids)})` : Prisma.sql`false`;
}

/** GREATEST skips NULLs, so a hidden term simply drops out. */
function lastActiveOn(visibility: ActivityVisibility): Prisma.Sql {
  const overview = inRowSet(visibility.overview);
  const developer = inRowSet(visibility.developer);
  return Prisma.sql`GREATEST(
    CASE WHEN ${overview} THEN (SELECT max(e.last_active_on) FROM end_users e WHERE e.application_id = a.id) END,
    CASE WHEN ${overview} AND ${developer} THEN (SELECT max(k.last_used_at)::date FROM api_keys k WHERE k.application_id = a.id) END
  )`;
}

/**
 * One page of a workspace's Applications, filtered and sorted.
 *
 * `created` is newest first, `name` is A to Z ignoring case, `activity` is
 * most recently active first with never-active rows last. Every order ends on
 * `id` so a page boundary never repeats or skips a row.
 *
 * @example
 * const { items, total } = await listApplications({
 *   tenantId, ids: undefined, filter: { status: 'active', sort: 'name' },
 *   take: 25, skip: 0, activity: { overview: { all: true }, developer: { all: true } },
 * });
 */
export async function listApplications(opts: {
  tenantId: string;
  ids: string[] | undefined;
  filter: ApplicationListFilter;
  take: number;
  skip: number;
  activity: ActivityVisibility;
}): Promise<{ items: Application[]; total: number }> {
  const { tenantId, ids, filter, take, skip } = opts;
  const where = whereFor(tenantId, ids, filter);
  const total = prisma.application.count({ where });

  if (filter.sort === undefined || filter.sort === 'created') {
    const orderBy: Prisma.ApplicationOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'asc' }];
    const [items, count] = await Promise.all([prisma.application.findMany({ where, orderBy, take, skip }), total]);
    return { items, total: count };
  }

  // Both orders are expressions Prisma's orderBy cannot state: a lower-cased
  // name, and a per-row aggregate. So the page's ids come from SQL.
  const orderBy =
    filter.sort === 'name'
      ? Prisma.sql`lower(a.name) ASC, a.id ASC`
      : Prisma.sql`${lastActiveOn(opts.activity)} DESC NULLS LAST, a.created_at DESC, a.id ASC`;
  const [ordered, count] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT a.id FROM applications a
      WHERE ${sqlWhere(tenantId, ids, filter)}
      ORDER BY ${orderBy}
      LIMIT ${take} OFFSET ${skip}`,
    total,
  ]);
  const rows = await prisma.application.findMany({ where: { id: { in: ordered.map((r) => r.id) } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { items: ordered.map((r) => byId.get(r.id)).filter((r): r is Application => r !== undefined), total: count };
}

/**
 * Key and activity figures for a page of Applications, in one query whatever
 * the page size. Callers drop the fields the viewer may not read.
 */
export async function applicationSummaries(
  ids: string[],
  activity: ActivityVisibility,
): Promise<Map<string, { activeApiKeys: number; lastActiveOn: string | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ id: string; active_api_keys: number; last_active_on: Date | null }>>`
    SELECT a.id,
      (SELECT count(*)::int FROM api_keys k
        WHERE k.application_id = a.id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
      ) AS active_api_keys,
      ${lastActiveOn(activity)} AS last_active_on
    FROM applications a
    WHERE a.id IN (${Prisma.join(ids)})`;
  return new Map(
    rows.map((r) => [r.id, { activeApiKeys: r.active_api_keys, lastActiveOn: r.last_active_on?.toISOString() ?? null }]),
  );
}
