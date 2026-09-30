/**
 * Where a calendar day of a timezone starts and ends, as the naive UTC
 * timestamps the database columns hold.
 */

import { addDays } from '../range.js';

function offsetMs(timezone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * The instant local midnight of `day` falls on in `timezone`.
 *
 * @example
 *   localMidnight('2026-10-01', 'Asia/Kolkata') // 2026-09-30T18:30:00.000Z
 */
export function localMidnight(day: string, timezone: string): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const first = guess - offsetMs(timezone, guess);
  return new Date(guess - offsetMs(timezone, first));
}

/** `[start, end)` of `day` in `timezone`. */
export function dayWindow(day: string, timezone: string): { start: Date; end: Date } {
  return { start: localMidnight(day, timezone), end: localMidnight(addDays(day, 1), timezone) };
}
