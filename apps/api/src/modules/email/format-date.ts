/**
 * The readable dates in built-in emails.
 *
 * Built by hand from the UTC fields rather than with `Intl`, so the output is
 * the same on every server whatever its locale data, time zone or ICU build.
 * The send path knows nothing about the reader's time zone, so the zone is
 * always spelled out.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Format an ISO 8601 instant as "27 Sep 2026, 14:50 UTC". A value that is not
 * a date comes back unchanged, so a mail never says "Invalid Date".
 *
 * @example
 * formatUtcDateTime('2026-09-27T14:50:00.000Z'); // '27 Sep 2026, 14:50 UTC'
 */
export function formatUtcDateTime(iso: string): string {
  if (iso.trim() === '') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
