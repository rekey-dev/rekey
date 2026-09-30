/**
 * One Users-overview section: scope gate, cache, compute budget, and the
 * envelope that lets each section succeed or fail on its own.
 */

import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { AnalyticsFilters, AnalyticsMetricGap, AnalyticsSection, AnalyticsSectionEnvelope } from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';
import { cachedSwr } from '../../lib/swr-cache.js';
import { dashboardSlots, DASHBOARD_RETRY_AFTER_SECONDS } from '../../lib/compute-semaphore.js';
import { withReadOnlyBudget } from '../../lib/read-budget.js';
import { scopeDenied } from '../../lib/access-context.js';
import type { Scope } from '../../lib/operator-scopes.js';
import { activeFilterNames } from './filters.js';
import type { ResolvedRange } from './range.js';
import { analyticsVersionKey } from './timezone-change.js';

export interface SectionContext {
  applicationId: string;
  range: ResolvedRange;
  filters: AnalyticsFilters;
  scopes: ReadonlySet<Scope>;
  /** Today's UTC day, which the live path counts from. */
  todayUtc: string;
  /** Day the Application started tracking activity, or null when that was its creation day. */
  trackedSince: string | null;
  billingEnabled: boolean;
  profileField: string | null;
  /** `rollup` reads activity from the daily rollup in `range.timezone`; `live` counts UTC days from the bits. */
  mode: 'live' | 'rollup';
  /** Called before each section is computed (a cache miss); may refuse with a 429. */
  chargeCompute?: () => Promise<void>;
}

export type SectionResult<T> =
  | { kind: 'ok'; data: T; source: 'rollup' | 'live'; timezone: string; gaps?: AnalyticsMetricGap[] }
  | { kind: 'unavailable'; reason: 'needs_rollup' | 'billing_disabled' | 'not_captured' | 'outside_window'; fix: string };

export interface SectionSpec<T> {
  name: AnalyticsSection;
  /** Needed on top of the route's `overview:read`. */
  scope: Scope;
  /** Filter names this section applies; any other present filter is reported as ignored. */
  applies: readonly string[] | 'all';
  freshSeconds: number;
  compute: (db: Prisma.TransactionClient, ctx: SectionContext) => Promise<SectionResult<T>>;
}

export interface SectionLogger {
  info(obj: object, msg: string): void;
}

const STALE_SECONDS = 15 * 60;
export const CACHE_KEY_VERSION = 'v1';

function sectionTimeout(): RekeyError {
  return new RekeyError({
    statusCode: 503,
    code: 'ANALYTICS_TIMEOUT',
    message: 'This section took longer than its query budget allows.',
    fix: 'Narrow the range or remove a filter.',
  });
}

let delayForTests: Partial<Record<AnalyticsSection, number>> = {};

/** Make a section run `pg_sleep(ms)` first, to exercise the statement timeout. */
export function __setSectionDelayForTests(delays: Partial<Record<AnalyticsSection, number>>): void {
  delayForTests = delays;
}

/**
 * The cache key for one section of one query. It never contains who asked:
 * the scope gate runs before the cache, and the cached value is the same for
 * every caller allowed to see it.
 */
export function sectionCacheKey(section: AnalyticsSection, ctx: SectionContext): string {
  const canonical = JSON.stringify({
    from: ctx.range.from,
    to: ctx.range.to,
    compare: ctx.range.compare,
    tz: ctx.range.timezone,
    mode: ctx.mode,
    todayUtc: ctx.todayUtc,
    filters: ctx.filters,
    profileField: ctx.profileField,
    billingEnabled: ctx.billingEnabled,
  });
  const digest = createHash('sha1').update(canonical).digest('hex');
  return `rk:an:users:${CACHE_KEY_VERSION}:${ctx.applicationId}:${section}:${digest}`;
}

function ignoredFilters(spec: SectionSpec<unknown>, f: AnalyticsFilters): string[] {
  if (spec.applies === 'all') return [];
  const applies = spec.applies;
  return activeFilterNames(f).filter((n) => !applies.includes(n));
}

/**
 * @example
 *   const envelope = await runSection(kpisSection, ctx, { explicit: false, log: req.log });
 */
export async function runSection<T>(
  spec: SectionSpec<T>,
  ctx: SectionContext,
  options: { explicit: boolean; log?: SectionLogger },
): Promise<{ envelope: AnalyticsSectionEnvelope<T>; busy: boolean }> {
  if (!ctx.scopes.has(spec.scope)) {
    if (options.explicit) throw scopeDenied(spec.scope);
    return { envelope: { status: 'forbidden', scope: spec.scope }, busy: false };
  }
  try {
    return { envelope: await computeEnvelope(spec, ctx, options.log), busy: false };
  } catch (err) {
    if (err instanceof RekeyError && err.code === 'ANALYTICS_BUSY') {
      return { envelope: { status: 'pending', retryAfterSeconds: DASHBOARD_RETRY_AFTER_SECONDS }, busy: true };
    }
    throw err;
  }
}

async function computeEnvelope<T>(
  spec: SectionSpec<T>,
  ctx: SectionContext,
  log: SectionLogger | undefined,
): Promise<AnalyticsSectionEnvelope<T>> {
  const started = Date.now();
  try {
    const cached = await cachedSwr(
      sectionCacheKey(spec.name, ctx),
      { freshSeconds: spec.freshSeconds, staleSeconds: STALE_SECONDS, versionKey: analyticsVersionKey(ctx.applicationId) },
      () =>
        (ctx.chargeCompute ?? (async () => undefined))().then(() =>
          dashboardSlots.run(() =>
          withReadOnlyBudget(
            async (tx) => {
              const delay = delayForTests[spec.name];
              if (delay) await tx.$queryRawUnsafe(`SELECT pg_sleep(${delay / 1000})`);
              return spec.compute(tx, ctx);
            },
            { onTimeout: sectionTimeout },
          ),
          ),
        ),
    );
    if (cached.status === 'pending') return { status: 'pending', retryAfterSeconds: cached.retryAfterSeconds };
    const result = cached.value;
    log?.info(
      { section: spec.name, source: result.kind === 'ok' ? result.source : 'none', cacheHit: cached.cache.hit, ms: Date.now() - started },
      'analytics section',
    );
    if (result.kind === 'unavailable') return { status: 'unavailable', reason: result.reason, fix: result.fix };
    return {
      status: 'ok',
      source: result.source,
      timezone: result.timezone,
      computedAt: cached.computedAt,
      cache: cached.cache,
      data: result.data,
      ignoredFilters: ignoredFilters(spec as SectionSpec<unknown>, ctx.filters),
      gaps: result.gaps ?? [],
    };
  } catch (err) {
    if (err instanceof RekeyError && (err.code === 'ANALYTICS_BUSY' || err.statusCode < 500)) throw err;
    if (err instanceof RekeyError) {
      return { status: 'error', error: { code: err.code, message: err.message, fix: err.fix ?? '' } };
    }
    throw err;
  }
}
