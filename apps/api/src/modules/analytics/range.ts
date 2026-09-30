/**
 * Calendar-day arithmetic and range resolution for the Users overview.
 *
 * Days are `YYYY-MM-DD` strings throughout. A preset resolves against "today"
 * in the Application's reporting timezone, so the cache key for a preset is
 * stable for a whole local day.
 */

import { ANALYTICS_ROLLUP_MAX_DAYS, type AnalyticsUsersQuery } from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';

const DAY_MS = 86_400_000;

export interface ResolvedRange {
  from: string;
  to: string;
  days: number;
  timezone: string;
  today: string;
  compare: { from: string; to: string } | null;
}

/**
 * The calendar day it is now in `timezone`.
 *
 * @example
 *   todayIn('Asia/Kolkata', new Date('2026-09-30T20:00:00Z')) // '2026-10-01'
 */
export function todayIn(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** @example addDays('2026-03-01', -1) // '2026-02-28' */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`. @example daysBetween('2026-01-01', '2026-01-31') // 30 */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Every day from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const n = daysBetween(from, to);
  return Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
}

/** The UTC day of a timestamp or a `@db.Date`. */
export function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 } as const;

function rangeInvalid(detail: string): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'ANALYTICS_RANGE_INVALID',
    message: `The date range is not valid: ${detail}`,
    fix: 'Use range=7d|30d|90d|12m, or range=custom with from and to as YYYY-MM-DD in the reporting timezone, from <= to <= today.',
  });
}

/**
 * @example
 *   rangeTooLong(63, 'Remove the plan or organization filter, or use at most one of platform, country and via, to use the daily rollup.')
 */
export function rangeTooLong(maxDays: number, hint: string): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'ANALYTICS_RANGE_TOO_LONG',
    message: `The date range is longer than the ${maxDays} days this request can answer.`,
    fix: `Shorten the range to ${maxDays} days or less. ${hint}`.trim(),
  });
}

function validDay(day: string): boolean {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && utcDay(new Date(t)) === day;
}

/**
 * Resolve the query's range against today in `timezone`.
 *
 * @example
 *   resolveRange({ range: '30d', compare: 'prev' }, 'UTC')
 */
export function resolveRange(
  q: Pick<AnalyticsUsersQuery, 'range' | 'from' | 'to' | 'compare'>,
  timezone: string,
  now: Date = new Date(),
): ResolvedRange {
  const today = todayIn(timezone, now);
  let from: string;
  let to: string;
  if (q.range === 'custom') {
    if (!q.from || !q.to) throw rangeInvalid('range=custom needs both from and to.');
    if (!validDay(q.from) || !validDay(q.to)) throw rangeInvalid('from and to must be real calendar days.');
    from = q.from;
    to = q.to;
    if (from > to) throw rangeInvalid('from is after to.');
    if (to > today) throw rangeInvalid(`to is after today (${today} in ${timezone}).`);
  } else {
    if (q.from || q.to) throw rangeInvalid('from and to are only read with range=custom.');
    to = today;
    from = addDays(today, -(PRESET_DAYS[q.range] - 1));
  }
  const days = daysBetween(from, to) + 1;
  if (days > ANALYTICS_ROLLUP_MAX_DAYS) throw rangeTooLong(ANALYTICS_ROLLUP_MAX_DAYS, '');
  const compare =
    q.compare === 'prev' ? { from: addDays(from, -days), to: addDays(from, -1) } : null;
  return { from, to, days, timezone, today, compare };
}
