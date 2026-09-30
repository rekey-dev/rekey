/**
 * C: platform, country, latest sign-in method, sign-up source and linked
 * OAuth providers. A breakdown is never filtered on its own dimension, so a
 * `platform=ios` filter still shows the whole platform bar list.
 */

import { Prisma } from '@prisma/client';
import type { AnalyticsMix } from '@rekey.dev/shared-types';
import { activeFilterNames, userFilterSql } from '../filters.js';
import { addDays } from '../range.js';
import { breakdown } from '../breakdown.js';
import type { SectionContext, SectionResult, SectionSpec } from '../envelope.js';
import { dayStart } from './kpis.js';

type Group = { key: string | null; n: bigint };

async function computeMix(db: Prisma.TransactionClient, ctx: SectionContext): Promise<SectionResult<AnalyticsMix>> {
  const app = ctx.applicationId;
  const f = ctx.filters;
  const from = ctx.range.from;
  const fromStart = dayStart(from);
  const toEnd = dayStart(addDays(ctx.range.to, 1));

  const platform = await db.$queryRaw<Group[]>(Prisma.sql`
    SELECT eu."last_platform" AS key, count(*) AS n FROM "end_users" AS eu
     WHERE eu."application_id" = ${app} AND eu."last_active_on" >= ${from}::date
       ${userFilterSql(f, { skip: 'platform' })}
     GROUP BY 1`);
  const country = await db.$queryRaw<Group[]>(Prisma.sql`
    SELECT eu."last_country"::text AS key, count(*) AS n FROM "end_users" AS eu
     WHERE eu."application_id" = ${app} AND eu."last_active_on" >= ${from}::date
       ${userFilterSql(f, { skip: 'country' })}
     GROUP BY 1`);
  const via = await db.$queryRaw<Group[]>(Prisma.sql`
    SELECT eu."last_sign_in_via" AS key, count(*) AS n FROM "end_users" AS eu
     WHERE eu."application_id" = ${app} AND eu."last_signed_in_at" >= ${fromStart} AND eu."last_signed_in_at" < ${toEnd}
       ${userFilterSql(f, { skip: 'via' })}
     GROUP BY 1`);
  const createdVia = await db.$queryRaw<Group[]>(Prisma.sql`
    SELECT eu."created_via" AS key, count(*) AS n FROM "end_users" AS eu
     WHERE eu."application_id" = ${app} AND eu."created_at" >= ${fromStart} AND eu."created_at" < ${toEnd}
       ${userFilterSql(f, { skip: 'createdVia' })}
     GROUP BY 1`);
  const oauth = await db.$queryRaw<Group[]>(Prisma.sql`
    SELECT oi."provider" AS key, count(DISTINCT oi."end_user_id") AS n
      FROM "oauth_identities" AS oi
      JOIN "end_users" AS eu ON eu."id" = oi."end_user_id"
     WHERE oi."application_id" = ${app}
       ${userFilterSql(f)}
     GROUP BY 1`);

  const snapshot = await db.applicationPopulationSnapshot.findFirst({
    where: { applicationId: app },
    orderBy: { takenOn: 'desc' },
    select: { takenOn: true, liveSessions: true },
  });
  const sessions = snapshot?.liveSessions as Record<'platform' | 'os' | 'browser' | 'appVersion', Record<string, number>> | undefined;
  const fromMap = (m: Record<string, number> | undefined) =>
    breakdown(Object.entries(m ?? {}).map(([k, n]) => ({ key: k === 'unknown' ? null : k, n })));

  return {
    kind: 'ok',
    source: 'live',
    timezone: 'UTC',
    data: {
      liveSessions: snapshot
        ? {
            takenOn: snapshot.takenOn.toISOString().slice(0, 10),
            platform: fromMap(sessions?.platform),
            os: fromMap(sessions?.os),
            browser: fromMap(sessions?.browser),
            appVersion: fromMap(sessions?.appVersion),
            ignoredFilters: activeFilterNames(f),
          }
        : null,
      platform: breakdown(platform),
      country: breakdown(country),
      lastSignInVia: breakdown(via),
      createdVia: breakdown(createdVia),
      oauthProviders: breakdown(oauth),
    },
  };
}

export const mixSection: SectionSpec<AnalyticsMix> = {
  name: 'mix',
  scope: 'overview:read',
  applies: 'all',
  freshSeconds: 60,
  compute: computeMix,
};
