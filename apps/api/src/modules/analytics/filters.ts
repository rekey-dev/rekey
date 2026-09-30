/**
 * The Users overview filters: canonical form, access checks, and the SQL that
 * applies them to `end_users`.
 *
 * Platform, country and via describe the user's LATEST values
 * (`last_platform`, `last_country`, `last_sign_in_via`), not each event.
 */

import { Prisma } from '@prisma/client';
import type { AnalyticsFilters, AnalyticsUsersQuery } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { scopeDenied } from '../../lib/access-context.js';
import type { Scope } from '../../lib/operator-scopes.js';

/** Subscription statuses that count a user as paying. */
export const PAYING_STATUSES = ['ACTIVE', 'TRIALING', 'PAST_DUE'] as const;

const sorted = (values: readonly string[] | undefined): string[] => [...(values ?? [])].sort();

/**
 * @example
 *   canonicalFilters({ platform: ['web', 'ios'] }) // { platform: ['ios', 'web'], ... }
 */
export function canonicalFilters(q: Partial<AnalyticsUsersQuery>): AnalyticsFilters {
  return {
    platform: sorted(q.platform),
    country: sorted(q.country),
    via: sorted(q.via),
    createdVia: sorted(q.createdVia),
    onboarding: q.onboarding ?? null,
    verified: q.verified ?? null,
    mfa: q.mfa ?? null,
    plan: q.plan ?? null,
    paying: q.paying ?? null,
    org: q.org ?? null,
  };
}

/** Names of the filters present, for `ignoredFilters`. */
export function activeFilterNames(f: AnalyticsFilters): string[] {
  const out: string[] = [];
  if (f.platform.length) out.push('platform');
  if (f.country.length) out.push('country');
  if (f.via.length) out.push('via');
  if (f.createdVia.length) out.push('createdVia');
  if (f.onboarding) out.push('onboarding');
  if (f.verified !== null) out.push('verified');
  if (f.mfa !== null) out.push('mfa');
  if (f.plan) out.push('plan');
  if (f.paying !== null) out.push('paying');
  if (f.org) out.push('org');
  return out;
}

function planNotFound(planId: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'PLAN_NOT_FOUND',
    message: `Plan "${planId}" not found in this Application.`,
    fix: 'List plans via GET /api/v1/tenant/applications/:id/plans and pass a plan id from there.',
  });
}

function organizationNotFound(orgId: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'ORGANIZATION_NOT_FOUND',
    message: `Organization "${orgId}" not found in this Application.`,
    fix: 'List organizations via GET /api/v1/tenant/applications/:id/organizations and pass an id from there.',
  });
}

/**
 * Refuse a filter the caller may not use, and one naming another
 * Application's plan or organization. Refused rather than ignored: an ignored
 * filter returns unfiltered numbers the caller reads as filtered.
 *
 * @example
 *   await assertFiltersAllowed(filters, access.scopes, applicationId);
 */
export async function assertFiltersAllowed(
  f: AnalyticsFilters,
  scopes: ReadonlySet<Scope>,
  applicationId: string,
): Promise<void> {
  if ((f.plan || f.paying !== null) && !scopes.has('billing:read')) throw scopeDenied('billing:read');
  if (f.org && !scopes.has('organizations:read')) throw scopeDenied('organizations:read');
  if (f.plan) {
    const plan = await prisma.plan.findFirst({ where: { id: f.plan, applicationId }, select: { id: true } });
    if (!plan) throw planNotFound(f.plan);
  }
  if (f.org) {
    const org = await prisma.organization.findFirst({ where: { id: f.org, applicationId }, select: { id: true } });
    if (!org) throw organizationNotFound(f.org);
  }
}

function createdViaSql(values: string[], alias: Prisma.Sql): Prisma.Sql {
  const parts = values.map((v) => {
    if (v === 'unknown') return Prisma.sql`${alias}."created_via" IS NULL`;
    if (v === 'oauth') return Prisma.sql`(${alias}."created_via" = 'oauth' OR ${alias}."created_via" LIKE 'oauth:%')`;
    return Prisma.sql`${alias}."created_via" = ${v}`;
  });
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

export interface FilterSqlOptions {
  /** Leave one dimension out, for a breakdown by that dimension. */
  skip?: 'platform' | 'country' | 'via' | 'createdVia';
}

/**
 * The filters as `AND ...` conditions on an `end_users` alias. Empty when no
 * filter is set.
 *
 * @example
 *   Prisma.sql`SELECT count(*) FROM end_users eu WHERE eu.application_id = ${id} ${userFilterSql(f)}`
 */
export function userFilterSql(f: AnalyticsFilters, options: FilterSqlOptions = {}, aliasName = 'eu'): Prisma.Sql {
  const a = Prisma.raw(`"${aliasName}"`);
  const conds: Prisma.Sql[] = [];
  if (f.platform.length && options.skip !== 'platform') conds.push(Prisma.sql`${a}."last_platform" = ANY(${f.platform}::text[])`);
  if (f.country.length && options.skip !== 'country') conds.push(Prisma.sql`${a}."last_country"::text = ANY(${f.country}::text[])`);
  if (f.via.length && options.skip !== 'via') conds.push(Prisma.sql`${a}."last_sign_in_via" = ANY(${f.via}::text[])`);
  if (f.createdVia.length && options.skip !== 'createdVia') conds.push(createdViaSql(f.createdVia, a));
  if (f.onboarding === 'completed') conds.push(Prisma.sql`${a}."onboarding_completed_at" IS NOT NULL`);
  if (f.onboarding === 'skipped') {
    conds.push(Prisma.sql`${a}."onboarding_completed_at" IS NULL AND ${a}."onboarding_skipped_at" IS NOT NULL`);
  }
  if (f.onboarding === 'pending') {
    conds.push(Prisma.sql`${a}."onboarding_completed_at" IS NULL AND ${a}."onboarding_skipped_at" IS NULL`);
  }
  if (f.verified !== null) conds.push(Prisma.sql`${a}."email_verified" = ${f.verified}`);
  if (f.mfa !== null) {
    const exists = Prisma.sql`EXISTS (SELECT 1 FROM "mfa_credentials" m WHERE m."end_user_id" = ${a}."id" AND m."enrolled_at" IS NOT NULL)`;
    conds.push(f.mfa ? exists : Prisma.sql`NOT ${exists}`);
  }
  const paying = Prisma.sql`s."status"::text = ANY(${[...PAYING_STATUSES]}::text[])`;
  if (f.plan) {
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."end_user_id" = ${a}."id" AND s."plan_id" = ${f.plan} AND ${paying})`,
    );
  }
  if (f.paying !== null) {
    const exists = Prisma.sql`EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."end_user_id" = ${a}."id" AND ${paying})`;
    conds.push(f.paying ? exists : Prisma.sql`NOT ${exists}`);
  }
  if (f.org) {
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "organization_memberships" om WHERE om."end_user_id" = ${a}."id" AND om."organization_id" = ${f.org})`,
    );
  }
  if (conds.length === 0) return Prisma.empty;
  return Prisma.sql`AND ${Prisma.join(conds, ' AND ')}`;
}

/**
 * True when the rollup can answer these filters: at most one of platform,
 * country and via (the dimensions it keeps activity for), and none of the
 * live-only filters. Sign-up source is live-only: the rollup keeps sign-ups
 * per source but no activity per source.
 */
export function rollupCompatible(f: AnalyticsFilters): boolean {
  const { liveOnly, dimensions } = rollupBlockers(f);
  return dimensions.length <= 1 && liveOnly.length === 0;
}

const ROLLUP_DIMENSIONS = ['platform', 'country', 'via'];

/**
 * The present filters that keep the rollup from answering: every live-only
 * one, and the dimensions when more than one is set.
 *
 * @example
 *   rollupBlockers(filters) // { liveOnly: ['createdVia'], dimensions: ['platform', 'country'] }
 */
export function rollupBlockers(f: AnalyticsFilters): { liveOnly: string[]; dimensions: string[] } {
  const present = activeFilterNames(f);
  return {
    liveOnly: present.filter((n) => !ROLLUP_DIMENSIONS.includes(n)),
    dimensions: present.filter((n) => ROLLUP_DIMENSIONS.includes(n)),
  };
}

/**
 * The part of an `ANALYTICS_RANGE_TOO_LONG` fix that names what to remove so
 * the rollup can answer, built from the filters actually present.
 *
 * @example
 *   rollupFixHint(filters) // 'Or remove the createdVia filter, so the daily rollup can answer it.'
 */
export function rollupFixHint(f: AnalyticsFilters): string {
  const { liveOnly, dimensions } = rollupBlockers(f);
  const steps: string[] = [];
  if (liveOnly.length) steps.push(`remove the ${joinNames(liveOnly)} filter${liveOnly.length > 1 ? 's' : ''}`);
  if (dimensions.length > 1) steps.push(`keep only one of the ${joinNames(dimensions, 'or')} filters`);
  return steps.length ? `Or ${steps.join(' and ')}, so the daily rollup can answer it.` : '';
}

function joinNames(names: string[], last = 'and'): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} ${last} ${names.at(-1)}`;
}
