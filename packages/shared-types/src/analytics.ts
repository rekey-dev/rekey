import { z } from 'zod';
import { CLIENT_PLATFORMS } from './client-platform.js';
import { CreatedViaSchema } from './created-via.js';

/**
 * The sections `GET /api/v1/tenant/applications/:id/analytics/users` can
 * return. The panel asks for `kpis,activity` and the rest in two calls.
 */
export const ANALYTICS_SECTIONS = [
  'kpis',
  'activity',
  'mix',
  'onboarding',
  'retention',
  'security',
  'billing',
  'usage',
] as const;
export type AnalyticsSection = (typeof ANALYTICS_SECTIONS)[number];

export const ANALYTICS_RANGE_PRESETS = ['7d', '30d', '90d', '12m', 'custom'] as const;
export type AnalyticsRangePreset = (typeof ANALYTICS_RANGE_PRESETS)[number];

/** How a sign-in authenticated. `mfa` hides the first factor. */
export const SIGN_IN_VIAS = ['password', 'magic_link', 'oauth', 'passkey', 'mfa'] as const;
export type SignInVia = (typeof SIGN_IN_VIAS)[number];

export const ANALYTICS_ONBOARDING = ['pending', 'completed', 'skipped'] as const;

/** Days the live path can answer: the activity bits' window. */
export const ANALYTICS_LIVE_MAX_DAYS = 63;
/** Days the rollup path can answer. */
export const ANALYTICS_ROLLUP_MAX_DAYS = 366;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function commaList<T extends z.ZodTypeAny>(item: T, max: number) {
  return z
    .string()
    .transform((s) => [...new Set(s.split(',').map((v) => v.trim()).filter(Boolean))])
    .pipe(z.array(item).max(max, `At most ${max} values.`));
}

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/**
 * The query string, as received. Dates are `YYYY-MM-DD` calendar days in the
 * Application's reporting timezone.
 *
 * @example
 *   AnalyticsUsersQuerySchema.parse({ range: '30d', platform: 'ios,web', verified: 'true' })
 */
export const AnalyticsUsersQuerySchema = z
  .object({
    range: z.enum(ANALYTICS_RANGE_PRESETS).default('30d'),
    from: z.string().regex(DATE, 'Use YYYY-MM-DD.').optional(),
    to: z.string().regex(DATE, 'Use YYYY-MM-DD.').optional(),
    compare: z.enum(['prev', 'none']).default('prev'),
    sections: commaList(z.enum(ANALYTICS_SECTIONS), ANALYTICS_SECTIONS.length).optional(),
    platform: commaList(z.enum(CLIENT_PLATFORMS), CLIENT_PLATFORMS.length).optional(),
    country: commaList(
      z
        .string()
        .transform((c) => c.toUpperCase())
        .pipe(z.string().regex(/^[A-Z]{2}$/, 'Use ISO 3166-1 alpha-2 codes.')),
      10,
    ).optional(),
    via: commaList(z.enum(SIGN_IN_VIAS), SIGN_IN_VIAS.length).optional(),
    createdVia: commaList(CreatedViaSchema, 10).optional(),
    onboarding: z.enum(ANALYTICS_ONBOARDING).optional(),
    verified: bool.optional(),
    mfa: bool.optional(),
    plan: z.string().min(1).max(64).optional(),
    paying: bool.optional(),
    org: z.string().min(1).max(64).optional(),
    profileField: z.string().min(1).max(64).optional(),
  })
  .strict();
export type AnalyticsUsersQuery = z.infer<typeof AnalyticsUsersQuerySchema>;

/** The filters actually applied, after canonicalisation. */
export interface AnalyticsFilters {
  platform: string[];
  country: string[];
  via: string[];
  /** Kinds (`oauth` matches every provider) or `oauth:<provider>`; `unknown` matches rows with none. */
  createdVia: string[];
  onboarding: (typeof ANALYTICS_ONBOARDING)[number] | null;
  verified: boolean | null;
  mfa: boolean | null;
  plan: string | null;
  paying: boolean | null;
  org: string | null;
}

/**
 * One number with its value for the comparison period. `delta` is
 * `value - previous` in the metric's own unit: a count difference for
 * counts, a difference of ratios (points / 100) for ratios. Null when either
 * side cannot be computed.
 */
export interface AnalyticsMetric {
  value: number | null;
  previous: number | null;
  delta: number | null;
}

export interface AnalyticsBreakdownRow {
  key: string;
  count: number;
  share: number;
}

/** Top rows plus the tail. `unknown` counts users with no value recorded. */
export interface AnalyticsBreakdown {
  rows: AnalyticsBreakdownRow[];
  other: number;
  unknown: number;
  total: number;
}

export interface AnalyticsCacheInfo {
  hit: boolean;
  ageSeconds: number;
  stale: boolean;
}

/**
 * Metrics a section returns as `null` on some days for a stated reason, so a
 * null is never read as zero. `filter_not_in_rollup`: the day's rollup row
 * holds no per-filter value for these metrics (a backfilled day outside the
 * live bits' 63-day window). `not_in_rollup`: the row holds none at all.
 */
export interface AnalyticsMetricGap {
  reason: 'filter_not_in_rollup' | 'not_in_rollup';
  metrics: string[];
  days: string[];
  fix: string;
}

export type AnalyticsSectionEnvelope<T> =
  | {
      status: 'ok';
      source: 'rollup' | 'live';
      /** The IANA zone the section's days are in. The live path is always `UTC`. */
      timezone: string;
      computedAt: string;
      cache: AnalyticsCacheInfo;
      data: T;
      /** Filters present on the request that this section does not apply. */
      ignoredFilters: string[];
      /** Why some metrics are null on some days. Empty when every null is outside what the source can answer. */
      gaps: AnalyticsMetricGap[];
    }
  | { status: 'error'; error: { code: string; message: string; fix: string } }
  | { status: 'forbidden'; scope: string }
  | { status: 'pending'; retryAfterSeconds: number }
  | {
      status: 'unavailable';
      reason: 'needs_rollup' | 'billing_disabled' | 'not_captured' | 'outside_window';
      fix: string;
    };

export interface AnalyticsKpis {
  /** Every end-user row, erased tombstones included. `erased` says how many of them are. */
  totalUsers: AnalyticsMetric & { erased: number };
  newUsers: AnalyticsMetric;
  /** Active on the last day of the range. */
  dau: AnalyticsMetric;
  /** Mean daily active users over the range. */
  dauAverage: AnalyticsMetric;
  wau: AnalyticsMetric;
  mau: AnalyticsMetric;
  /** `dauAverage / mau`, a ratio in 0..1. */
  stickiness: AnalyticsMetric;
  /** Users owning an ACTIVE, TRIALING or PAST_DUE subscription, now. */
  payingUsers: AnalyticsMetric;
  /** `payingUsers / totalUsers`, a ratio in 0..1. */
  conversion: AnalyticsMetric;
}

export interface AnalyticsActivityPoint {
  date: string;
  /** Null where the day is outside what the source can answer exactly. */
  dau: number | null;
  wau: number | null;
  mau: number | null;
  accountsCreated: number;
  previous: { date: string; dau: number | null; wau: number | null; mau: number | null; accountsCreated: number } | null;
}

/** A run of consecutive days computed in one timezone. */
export interface AnalyticsActivitySegment {
  timezone: string;
  from: string;
  to: string;
  points: AnalyticsActivityPoint[];
}

export interface AnalyticsSignInsPoint {
  date: string;
  total: number;
  byVia: Record<string, number>;
}

export interface AnalyticsActivity {
  /** One segment on the live path; the rollup path splits at a timezone change. */
  segments: AnalyticsActivitySegment[];
  /** Accounts that existed before the range, for the cumulative line. */
  accountsBefore: number;
  signIns:
    | {
        status: 'ok';
        timezone: string;
        from: string;
        to: string;
        points: AnalyticsSignInsPoint[];
        /** True when the points cover fewer days than the range (the live path reads the last 7). */
        partial: boolean;
        /** Only `via` applies here, as the method of each sign-in. */
        ignoredFilters: string[];
      }
    | { status: 'unavailable'; reason: 'needs_rollup' | 'not_captured'; fix: string };
}

/** C: who the users are, by their latest values. */
export interface AnalyticsMix {
  /** Users active on or after the range start, by `lastPlatform`. */
  platform: AnalyticsBreakdown;
  /** The same users, by `lastCountry`. Empty unless the deployment trusts CF-IPCountry. */
  country: AnalyticsBreakdown;
  /** Users who signed in during the range, by `lastSignInVia`. `mfa` hides the first factor. */
  lastSignInVia: AnalyticsBreakdown;
  /** Users created in the range, by `createdVia` (`oauth:<provider>` kept apart). */
  createdVia: AnalyticsBreakdown;
  /** Users with a linked OAuth identity, per provider, now. A user can count under several. */
  oauthProviders: AnalyticsBreakdown;
  /**
   * Live sessions (not rotated, revoked or expired) by client attribute, from the latest daily snapshot.
   * Null until the rollup has taken one. Not filtered.
   */
  liveSessions: {
    takenOn: string;
    platform: AnalyticsBreakdown;
    os: AnalyticsBreakdown;
    browser: AnalyticsBreakdown;
    appVersion: AnalyticsBreakdown;
    /** The snapshot is unfiltered: every filter on the request is ignored here. */
    ignoredFilters: string[];
  } | null;
}

export interface AnalyticsOnboardingCounts {
  completed: number;
  skipped: number;
  pending: number;
  total: number;
}

/** D: onboarding over the cohort created in the range, plus the whole population now. */
export interface AnalyticsOnboarding {
  funnel: {
    steps: Array<{ key: 'created' | 'verified' | 'first_sign_in' | 'onboarding_completed' | 'active_7d'; count: number }>;
    /** Cohort members who skipped and have not completed since. */
    skipped: number;
  };
  /** Every user now, by onboarding status. */
  counts: AnalyticsOnboardingCounts;
  /** The cohort created in the range, by onboarding status. */
  cohortCounts: AnalyticsOnboardingCounts;
  /** Median seconds from account creation to onboarding completion, over the cohort. */
  medianSecondsToComplete: number | null;
  /** The profile fields `profileField` may name: select and boolean fields. */
  fields: Array<{ key: string; label: string; type: 'select' | 'boolean' }>;
  /** Answers to `profileField` over the cohort; null when none was asked for. */
  answers: { key: string; label: string; breakdown: AnalyticsBreakdown } | null;
}

/** E: weekly cohorts of the last 8 weeks, UTC days. Week 0 is the sign-up week. */
export interface AnalyticsRetention {
  cohorts: Array<{
    /** First day of the cohort week. */
    weekStart: string;
    size: number;
    /** Users of the cohort active in week k after sign-up; null where the bits cannot answer. */
    retained: Array<number | null>;
  }>;
}

/** F: account health now (the range does not apply). */
export interface AnalyticsSecurity {
  total: number;
  verified: { count: number; share: number | null };
  mfa: { count: number; share: number | null };
  passkeys: { count: number; share: number | null };
  devices: { active: number; blocked: number; released: number };
  /** Failed sign-ins and lockouts live only in the rate limiter and cannot be charted. */
  lockouts: { status: 'unavailable'; reason: 'not_captured'; fix: string };
  /** Adoption per day from the daily snapshots in the range (unfiltered); empty before the rollup started. */
  trend: Array<{ date: string; timezone: string; total: number; verified: number; mfa: number; passkeys: number }>;
  /** The snapshots are unfiltered: every filter on the request is ignored by `trend`. */
  trendIgnoredFilters: string[];
}

/** G: subscription counts, never money. Needs `billing:read`. */
export interface AnalyticsBillingCounts {
  /** Live subscriptions (ACTIVE, TRIALING, PAST_DUE) now, by plan and status. */
  plans: Array<{ planId: string; planName: string; status: string; count: number }>;
  /** Trials that ended in the range: how many, and how many are ACTIVE now. */
  trialConversion: { ended: number; converted: number; rate: number | null };
}

/** G: usage by meter. Needs `billing:read`. */
export interface AnalyticsUsage {
  from: string;
  to: string;
  /** True when the live path read fewer days than the range. */
  partial: boolean;
  meters: Array<{ meterId: string; slug: string; name: string; unit: string; units: number }>;
}

export interface AnalyticsCoverage {
  /** First UTC day the live DAU is exact for. */
  activityFrom: string;
  /** First UTC day the live WAU is exact for. */
  wauFrom: string;
  /** First UTC day the live MAU is exact for. */
  mauFrom: string;
  /** When this Application started recording activity. */
  trackedSince: string;
  /** First day any sign-in event is still stored, or null when none is. */
  signInsFrom: string | null;
  /** First day the daily rollup holds for this Application, or null. */
  rollupFrom: string | null;
  /**
   * Days of the range, from `rollupFrom` on, with no rollup row: filled from the live bits when both are
   * UTC and within 63 days, null otherwise. Empty on the live path.
   */
  rollupMissingDays: string[];
  /** The Application's reporting timezone now. */
  timezone: string;
  /** Present when the reporting timezone changed inside the range. */
  timezoneNote: string | null;
}

export interface AnalyticsUsersResponse {
  asOf: string;
  range: {
    from: string;
    to: string;
    days: number;
    timezone: string;
    compare: { from: string; to: string } | null;
  };
  coverage: AnalyticsCoverage;
  filters: AnalyticsFilters;
  sections: Partial<Record<AnalyticsSection, AnalyticsSectionEnvelope<unknown>>>;
}
