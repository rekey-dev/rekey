/**
 * One `ApplicationPopulationSnapshot`: the Application's users as they stand
 * now. The cube keeps the filter combinations the rollup path answers
 * (platform x onboarding x verified x mfa x paying) without a row per user.
 */

import { Prisma } from '@prisma/client';
import { PAYING_STATUSES } from '../filters.js';

export interface CubeCell {
  platform: string | null;
  onboarding: 'completed' | 'skipped' | 'pending';
  verified: boolean;
  mfa: boolean;
  paying: boolean;
  n: number;
}

export interface PopulationData {
  total: number;
  erased: number;
  verified: number;
  mfaUsers: number;
  passkeyUsers: number;
  payingUsers: number;
  orgs: number;
  usersInOrg: number;
  devicesActive: number;
  devicesBlocked: number;
  cube: CubeCell[];
  onboarding: { completed: number; skipped: number; pending: number };
  byCountry: Record<string, number>;
  byLastVia: Record<string, number>;
  byCreatedVia: Record<string, number>;
  oauthByProvider: Record<string, number>;
  liveSessions: Record<'platform' | 'os' | 'browser' | 'appVersion', Record<string, number>>;
  planDistribution: Array<{ planId: string; status: string; n: number }>;
}

type Group = { key: string | null; n: bigint };
const toMap = (rows: Group[]): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.key ?? 'unknown', Number(r.n)]));

/**
 * @example
 *   const snapshot = await computePopulation(tx, applicationId);
 */
export async function computePopulation(db: Prisma.TransactionClient, applicationId: string): Promise<PopulationData> {
  const paying = Prisma.sql`s."status"::text = ANY(${[...PAYING_STATUSES]}::text[])`;
  const cubeRows = await db.$queryRaw<
    Array<{ platform: string | null; onboarding: CubeCell['onboarding']; verified: boolean; mfa: boolean; paying: boolean; n: bigint; erased: bigint }>
  >(Prisma.sql`
    SELECT eu."last_platform" AS platform,
           CASE WHEN eu."onboarding_completed_at" IS NOT NULL THEN 'completed'
                WHEN eu."onboarding_skipped_at" IS NOT NULL THEN 'skipped'
                ELSE 'pending' END AS onboarding,
           eu."email_verified" AS verified,
           (m."end_user_id" IS NOT NULL) AS mfa,
           EXISTS (SELECT 1 FROM "subscriptions" AS s WHERE s."end_user_id" = eu."id" AND ${paying}) AS paying,
           count(*) AS n,
           count(*) FILTER (WHERE eu."erased_at" IS NOT NULL) AS erased
      FROM "end_users" AS eu
      LEFT JOIN "mfa_credentials" AS m ON m."end_user_id" = eu."id" AND m."enrolled_at" IS NOT NULL
     WHERE eu."application_id" = ${applicationId}
     GROUP BY 1, 2, 3, 4, 5`);
  const cube: CubeCell[] = cubeRows.map((r) => ({
    platform: r.platform,
    onboarding: r.onboarding,
    verified: r.verified,
    mfa: r.mfa,
    paying: r.paying,
    n: Number(r.n),
  }));
  const sum = (pred: (c: CubeCell) => boolean): number => cube.filter(pred).reduce((s, c) => s + c.n, 0);

  const byCountry = await db.$queryRaw<Group[]>(Prisma.sql`
    SELECT eu."last_country"::text AS key, count(*) AS n FROM "end_users" AS eu
     WHERE eu."application_id" = ${applicationId} GROUP BY 1`);
  const byLastVia = await db.$queryRaw<Group[]>(Prisma.sql`
    SELECT eu."last_sign_in_via" AS key, count(*) AS n FROM "end_users" AS eu
     WHERE eu."application_id" = ${applicationId} GROUP BY 1`);
  const byCreatedVia = await db.$queryRaw<Group[]>(Prisma.sql`
    SELECT eu."created_via" AS key, count(*) AS n FROM "end_users" AS eu
     WHERE eu."application_id" = ${applicationId} GROUP BY 1`);
  const oauth = await db.$queryRaw<Group[]>(Prisma.sql`
    SELECT oi."provider" AS key, count(DISTINCT oi."end_user_id") AS n FROM "oauth_identities" AS oi
     WHERE oi."application_id" = ${applicationId} GROUP BY 1`);
  const [counts] = await db.$queryRaw<
    Array<{ passkeys: bigint; orgs: bigint; in_org: bigint; active: bigint; blocked: bigint }>
  >(Prisma.sql`
    SELECT (SELECT count(DISTINCT w."end_user_id") FROM "webauthn_credentials" AS w WHERE w."application_id" = ${applicationId}) AS passkeys,
           (SELECT count(*) FROM "organizations" AS o WHERE o."application_id" = ${applicationId}) AS orgs,
           (SELECT count(DISTINCT om."end_user_id") FROM "organization_memberships" AS om
              JOIN "organizations" AS o ON o."id" = om."organization_id"
             WHERE o."application_id" = ${applicationId}) AS in_org,
           (SELECT count(*) FROM "devices" AS d WHERE d."application_id" = ${applicationId} AND d."status" = 'ACTIVE') AS active,
           (SELECT count(*) FROM "devices" AS d WHERE d."application_id" = ${applicationId} AND d."status" = 'BLOCKED') AS blocked`);
  const sessions = await db.$queryRaw<
    Array<{ gp: number; go: number; gb: number; platform: string | null; os: string | null; browser: string | null; app_version: string | null; n: bigint }>
  >(Prisma.sql`
    SELECT GROUPING(rt."client_platform")::int AS gp, GROUPING(rt."client_os")::int AS go,
           GROUPING(rt."client_browser")::int AS gb,
           rt."client_platform" AS platform, rt."client_os" AS os, rt."client_browser" AS browser,
           rt."client_app_version" AS app_version, count(*) AS n
      FROM "refresh_tokens" AS rt
     WHERE rt."application_id" = ${applicationId}
       AND rt."replaced_by_id" IS NULL AND rt."revoked_at" IS NULL
       AND rt."expires_at" > now() AT TIME ZONE 'UTC'
     GROUP BY GROUPING SETS ((rt."client_platform"), (rt."client_os"), (rt."client_browser"), (rt."client_app_version"))`);
  const liveSessions: PopulationData['liveSessions'] = { platform: {}, os: {}, browser: {}, appVersion: {} };
  for (const s of sessions) {
    const n = Number(s.n);
    if (!s.gp) liveSessions.platform[s.platform ?? 'unknown'] = n;
    else if (!s.go) liveSessions.os[s.os ?? 'unknown'] = n;
    else if (!s.gb) liveSessions.browser[s.browser ?? 'unknown'] = n;
    else liveSessions.appVersion[s.app_version ?? 'unknown'] = n;
  }
  const plans = await db.$queryRaw<Array<{ plan_id: string; status: string; n: bigint }>>(Prisma.sql`
    SELECT s."plan_id", s."status"::text AS status, count(*) AS n FROM "subscriptions" AS s
     WHERE s."application_id" = ${applicationId} AND ${paying}
     GROUP BY 1, 2`);

  return {
    total: sum(() => true),
    erased: cubeRows.reduce((s, r) => s + Number(r.erased), 0),
    verified: sum((c) => c.verified),
    mfaUsers: sum((c) => c.mfa),
    passkeyUsers: Number(counts!.passkeys),
    payingUsers: sum((c) => c.paying),
    orgs: Number(counts!.orgs),
    usersInOrg: Number(counts!.in_org),
    devicesActive: Number(counts!.active),
    devicesBlocked: Number(counts!.blocked),
    cube,
    onboarding: {
      completed: sum((c) => c.onboarding === 'completed'),
      skipped: sum((c) => c.onboarding === 'skipped'),
      pending: sum((c) => c.onboarding === 'pending'),
    },
    byCountry: toMap(byCountry),
    byLastVia: toMap(byLastVia),
    byCreatedVia: toMap(byCreatedVia),
    oauthByProvider: toMap(oauth),
    liveSessions,
    planDistribution: plans.map((p) => ({ planId: p.plan_id, status: p.status, n: Number(p.n) })),
  };
}
