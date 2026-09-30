/**
 * D: the onboarding funnel over the cohort created in the range, status
 * counts for the whole population and the cohort, the median time to
 * complete, and the answers to one select or boolean profile field.
 */

import { Prisma } from '@prisma/client';
import type { AnalyticsOnboarding, AnalyticsOnboardingCounts } from '@rekey.dev/shared-types';
import { RekeyError } from '../../../lib/error.js';
import { readProfileSchema } from '../../end-users/profile-values.js';
import { userFilterSql } from '../filters.js';
import { addDays } from '../range.js';
import { breakdown } from '../breakdown.js';
import type { SectionContext, SectionResult, SectionSpec } from '../envelope.js';
import { dayStart } from './kpis.js';

interface FunnelRow {
  created: bigint;
  verified: bigint;
  first_sign_in: bigint;
  completed: bigint;
  skipped: bigint;
  active_7d: bigint;
  median_seconds: number | null;
}

interface CountsRow {
  total: bigint;
  completed: bigint;
  skipped: bigint;
}

const counts = (r: CountsRow): AnalyticsOnboardingCounts => ({
  total: Number(r.total),
  completed: Number(r.completed),
  skipped: Number(r.skipped),
  pending: Number(r.total) - Number(r.completed) - Number(r.skipped),
});

type AnswerField = { key: string; label: string; type: 'select' | 'boolean' };

export async function answerableFields(db: Prisma.TransactionClient, applicationId: string): Promise<AnswerField[]> {
  const app = await db.application.findUniqueOrThrow({ where: { id: applicationId }, select: { profileSchema: true } });
  return readProfileSchema(app.profileSchema)
    .filter((f): f is typeof f & { type: 'select' | 'boolean' } => f.type === 'select' || f.type === 'boolean')
    .map((f) => ({ key: f.key, label: f.label, type: f.type }));
}

/**
 * @example
 *   throw profileFieldUnsupported('team_size', ['plan_tier']);
 */
export function profileFieldUnsupported(key: string, allowed: string[]): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'ANALYTICS_FILTER_UNSUPPORTED',
    message: `"${key}" is not a select or boolean profile field of this Application, so its answers cannot be charted.`,
    fix: allowed.length
      ? `Use one of: ${allowed.join(', ')}.`
      : 'This Application has no select or boolean profile fields; add one under Users → Profile fields.',
  });
}

async function computeOnboarding(
  db: Prisma.TransactionClient,
  ctx: SectionContext,
): Promise<SectionResult<AnalyticsOnboarding>> {
  const app = ctx.applicationId;
  const fromStart = dayStart(ctx.range.from);
  const toEnd = dayStart(addDays(ctx.range.to, 1));
  const activeSince = addDays(ctx.todayUtc, -6);
  const filters = userFilterSql(ctx.filters);

  const [funnel] = await db.$queryRaw<FunnelRow[]>(Prisma.sql`
    SELECT count(*) AS created,
           count(*) FILTER (WHERE eu."email_verified") AS verified,
           count(*) FILTER (WHERE eu."first_signed_in_at" IS NOT NULL) AS first_sign_in,
           count(*) FILTER (WHERE eu."onboarding_completed_at" IS NOT NULL) AS completed,
           count(*) FILTER (WHERE eu."onboarding_completed_at" IS NULL AND eu."onboarding_skipped_at" IS NOT NULL) AS skipped,
           count(*) FILTER (WHERE eu."last_active_on" >= ${activeSince}::date) AS active_7d,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (eu."onboarding_completed_at" - eu."created_at"))
           ) FILTER (WHERE eu."onboarding_completed_at" IS NOT NULL) AS median_seconds
      FROM "end_users" AS eu
     WHERE eu."application_id" = ${app} AND eu."created_at" >= ${fromStart} AND eu."created_at" < ${toEnd}
       ${filters}`);
  const [population] = await db.$queryRaw<CountsRow[]>(Prisma.sql`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE eu."onboarding_completed_at" IS NOT NULL) AS completed,
           count(*) FILTER (WHERE eu."onboarding_completed_at" IS NULL AND eu."onboarding_skipped_at" IS NOT NULL) AS skipped
      FROM "end_users" AS eu
     WHERE eu."application_id" = ${app}
       ${filters}`);

  const fields = await answerableFields(db, app);
  let answers: AnalyticsOnboarding['answers'] = null;
  if (ctx.profileField) {
    const field = fields.find((f) => f.key === ctx.profileField);
    if (!field) throw profileFieldUnsupported(ctx.profileField, fields.map((f) => f.key));
    const groups = await db.$queryRaw<Array<{ key: string | null; n: bigint }>>(Prisma.sql`
      SELECT eu."profile"->>${field.key} AS key, count(*) AS n
        FROM "end_users" AS eu
       WHERE eu."application_id" = ${app} AND eu."created_at" >= ${fromStart} AND eu."created_at" < ${toEnd}
         ${filters}
       GROUP BY 1`);
    answers = { key: field.key, label: field.label, breakdown: breakdown(groups, 50) };
  }

  const f = funnel!;
  const cohort: CountsRow = { total: f.created, completed: f.completed, skipped: f.skipped };
  return {
    kind: 'ok',
    source: 'live',
    timezone: 'UTC',
    data: {
      funnel: {
        steps: [
          { key: 'created', count: Number(f.created) },
          { key: 'verified', count: Number(f.verified) },
          { key: 'first_sign_in', count: Number(f.first_sign_in) },
          { key: 'onboarding_completed', count: Number(f.completed) },
          { key: 'active_7d', count: Number(f.active_7d) },
        ],
        skipped: Number(f.skipped),
      },
      counts: counts(population!),
      cohortCounts: counts(cohort),
      medianSecondsToComplete: f.median_seconds === null ? null : Math.round(Number(f.median_seconds)),
      fields,
      answers,
    },
  };
}

export const onboardingSection: SectionSpec<AnalyticsOnboarding> = {
  name: 'onboarding',
  scope: 'overview:read',
  applies: 'all',
  freshSeconds: 60,
  compute: computeOnboarding,
};
