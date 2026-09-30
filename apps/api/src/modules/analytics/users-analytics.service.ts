/**
 * `GET .../analytics/users`: resolve the range and filters once, then run
 * each requested section on its own (lib/swr-cache.ts, the dashboard slots
 * and a read-only statement budget per section). Sections run one after
 * another, so a single request holds at most one pool connection.
 */

import {
  ANALYTICS_LIVE_MAX_DAYS,
  ANALYTICS_SECTIONS,
  BillingConfigSchema,
  type AnalyticsSection,
  type AnalyticsSectionEnvelope,
  type AnalyticsUsersQuery,
  type AnalyticsUsersResponse,
} from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { dashboardBusy } from '../../lib/compute-semaphore.js';
import type { Scope } from '../../lib/operator-scopes.js';
import { scopeDenied } from '../../lib/access-context.js';
import { assertFiltersAllowed, canonicalFilters, rollupCompatible, rollupFixHint } from './filters.js';
import { rollupFrom, rollupMissingDays } from './rollup/read.js';
import { computeCharger } from './compute-limit.js';
import { effectiveTimezone } from './pg-timezones.js';
import { exactFrom } from './live-activity.js';
import { rangeTooLong, resolveRange, utcDay } from './range.js';
import { runSection, type SectionContext, type SectionLogger, type SectionSpec } from './envelope.js';
import { kpisSection } from './sections/kpis.js';
import { activitySection } from './sections/activity.js';
import { mixSection } from './sections/mix.js';
import { onboardingSection } from './sections/onboarding.js';
import { retentionSection } from './sections/retention.js';
import { billingSection, securitySection, usageSection } from './sections/health.js';

const SECTIONS: Partial<Record<AnalyticsSection, SectionSpec<unknown>>> = {
  kpis: kpisSection as SectionSpec<unknown>,
  activity: activitySection as SectionSpec<unknown>,
  mix: mixSection as SectionSpec<unknown>,
  onboarding: onboardingSection as SectionSpec<unknown>,
  retention: retentionSection as SectionSpec<unknown>,
  security: securitySection as SectionSpec<unknown>,
  billing: billingSection as SectionSpec<unknown>,
  usage: usageSection as SectionSpec<unknown>,
};

function sectionUnsupported(section: string): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'ANALYTICS_FILTER_UNSUPPORTED',
    message: `The section "${section}" is not available on this deployment.`,
    fix: `Ask for sections from: ${Object.keys(SECTIONS).join(', ')}.`,
  });
}

/**
 * What a reader must know about zones: the live path is UTC, or the range
 * holds rollup days counted in a zone other than today's.
 */
async function timezoneNote(
  applicationId: string,
  mode: 'live' | 'rollup',
  range: { from: string; to: string },
  timezone: string,
): Promise<string | null> {
  if (mode === 'live') {
    return timezone === 'UTC'
      ? null
      : `This Application reports in ${timezone}, but these numbers come from the live path, which counts UTC days.`;
  }
  const others = await prisma.applicationActivityDay.groupBy({
    by: ['timezone'],
    where: {
      applicationId,
      day: { gte: new Date(`${range.from}T00:00:00Z`), lte: new Date(`${range.to}T00:00:00Z`) },
      timezone: { not: timezone },
    },
    _max: { day: true },
  });
  if (others.length === 0) return null;
  const parts = others.map((o) => `${o.timezone} (through ${o._max.day!.toISOString().slice(0, 10)})`);
  return `Some days in this range were counted in ${parts.join(', ')}. The reporting timezone is now ${timezone}; a change applies to days computed after it, and each segment names its zone.`;
}

async function signInsFrom(applicationId: string): Promise<string | null> {
  const first = await prisma.securityEvent.findFirst({
    where: { applicationId, type: 'user.signed_in' },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  return first ? utcDay(first.createdAt) : null;
}

/**
 * @example
 *   const data = await usersAnalytics({ applicationId, scopes: access.scopes, query, operatorId: req.tenantUser!.id, log: req.log });
 */
export async function usersAnalytics(args: {
  applicationId: string;
  scopes: ReadonlySet<Scope>;
  query: AnalyticsUsersQuery;
  log?: SectionLogger;
  /** The operator asking, for the per-operator compute limit (compute-limit.ts). Every caller passes it. */
  operatorId: string;
  now?: Date;
}): Promise<AnalyticsUsersResponse> {
  const { applicationId, query } = args;
  const now = args.now ?? new Date();
  const application = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    select: { reportingTimezone: true, activityTrackedSince: true, createdAt: true, billingConfig: true },
  });

  const filters = canonicalFilters(query);
  const firstRollupDay = await rollupFrom(applicationId);
  const compatible = rollupCompatible(filters);
  const mode = compatible && firstRollupDay !== null ? 'rollup' : 'live';
  const zone = await effectiveTimezone(application.reportingTimezone);
  const range = resolveRange(query, mode === 'rollup' ? zone.timezone : 'UTC', now);
  if (mode === 'live' && range.days > ANALYTICS_LIVE_MAX_DAYS) {
    // Dropping filters only helps once the rollup holds days; before that it
    // would lead to a second refusal.
    throw rangeTooLong(
      ANALYTICS_LIVE_MAX_DAYS,
      firstRollupDay === null
        ? 'Longer ranges are answered from the daily rollup, which holds no days for this Application yet.'
        : rollupFixHint(filters),
    );
  }
  await assertFiltersAllowed(filters, args.scopes, applicationId);
  if (query.profileField && !args.scopes.has('end-users:read')) throw scopeDenied('end-users:read');

  const requested = query.sections ?? (Object.keys(SECTIONS) as AnalyticsSection[]);
  for (const name of requested) if (!SECTIONS[name]) throw sectionUnsupported(name);

  const todayUtc = utcDay(now);
  const trackedDay = utcDay(application.activityTrackedSince);
  const ctx: SectionContext = {
    applicationId,
    range,
    filters,
    scopes: args.scopes,
    todayUtc,
    trackedSince: trackedDay === utcDay(application.createdAt) ? null : trackedDay,
    billingEnabled: BillingConfigSchema.parse(application.billingConfig ?? {}).enabled,
    profileField: query.profileField ?? null,
    mode,
    chargeCompute: computeCharger(args.operatorId, applicationId),
  };

  if (query.sections) {
    const denied = query.sections.map((n) => SECTIONS[n]!.scope).find((scope) => !args.scopes.has(scope));
    if (denied) throw scopeDenied(denied);
  }

  const sections: Partial<Record<AnalyticsSection, AnalyticsSectionEnvelope<unknown>>> = {};
  let computed = 0;
  let busy = 0;
  for (const name of ANALYTICS_SECTIONS) {
    if (!requested.includes(name)) continue;
    const spec = SECTIONS[name]!;
    const out = await runSection(spec, ctx, {
      explicit: query.sections !== undefined,
      ...(args.log && { log: args.log }),
    });
    sections[name] = out.envelope;
    if (out.envelope.status !== 'forbidden') computed += 1;
    if (out.busy) busy += 1;
  }
  if (computed > 0 && busy === computed) throw dashboardBusy();

  const okTimes = Object.values(sections)
    .map((s) => (s?.status === 'ok' ? s.computedAt : null))
    .filter((t): t is string => t !== null)
    .sort();
  return {
    asOf: okTimes.at(-1) ?? now.toISOString(),
    range: { from: range.from, to: range.to, days: range.days, timezone: range.timezone, compare: range.compare },
    coverage: {
      activityFrom: exactFrom('dau', todayUtc, ctx.trackedSince),
      wauFrom: exactFrom('wau', todayUtc, ctx.trackedSince),
      mauFrom: exactFrom('mau', todayUtc, ctx.trackedSince),
      trackedSince: trackedDay,
      signInsFrom: await signInsFrom(applicationId),
      rollupFrom: firstRollupDay,
      rollupMissingDays:
        mode === 'rollup' && firstRollupDay ? await rollupMissingDays(applicationId, range.from, range.to, firstRollupDay) : [],
      timezone: application.reportingTimezone,
      timezoneNote: zone.fallback
        ? `The database does not know the reporting timezone ${application.reportingTimezone}, so days are counted in UTC. Set it again under Developer > Lifecycle (for example Asia/Kolkata rather than Asia/Calcutta).`
        : await timezoneNote(applicationId, mode, range, zone.timezone),
    },
    filters,
    sections,
  };
}
