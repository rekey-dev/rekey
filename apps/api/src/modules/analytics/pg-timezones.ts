/**
 * Reporting timezones must be known to Postgres as well as to the runtime's
 * Intl: the rollup counts local days with `AT TIME ZONE`, and Postgres ships
 * its own zone list, without some legacy links ICU keeps (`Asia/Calcutta`,
 * `Europe/Kiev`). The list comes from `pg_timezone_names`, read once per
 * process; it depends on the server's tzdata, so a managed database on an
 * older or newer release can differ from a local one.
 */

import { canonicalTimezone } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';

let names: Promise<Map<string, string>> | null = null;

/** Lower-cased name to the database's spelling. */
function databaseZones(): Promise<Map<string, string>> {
  names ??= prisma
    .$queryRaw<Array<{ name: string }>>`SELECT name FROM pg_timezone_names`
    .then((rows) => new Map(rows.map((r) => [r.name.toLowerCase(), r.name])))
    .catch((err: unknown) => {
      names = null;
      throw err;
    });
  return names;
}

/**
 * The name to store for a submitted zone: `UTC` for its aliases, otherwise
 * the database's spelling of it. Null when Intl or Postgres does not know it.
 *
 * @example
 *   await resolveReportingTimezone('asia/kolkata') // 'Asia/Kolkata'
 *   await resolveReportingTimezone('Asia/Calcutta') // null on Postgres 16
 */
export async function resolveReportingTimezone(input: string): Promise<string | null> {
  const canonical = canonicalTimezone(input);
  if (canonical === null) return null;
  if (canonical === 'UTC') return 'UTC';
  return (await databaseZones()).get(canonical.toLowerCase()) ?? null;
}

/**
 * The zone to count days in for a stored value: the stored zone when the
 * database knows it, otherwise UTC, flagged, so a zone stored before this
 * check existed degrades to UTC instead of failing every request.
 *
 * @example
 *   const { timezone, fallback } = await effectiveTimezone(app.reportingTimezone);
 */
export async function effectiveTimezone(stored: string): Promise<{ timezone: string; fallback: boolean }> {
  if (stored === 'UTC') return { timezone: 'UTC', fallback: false };
  const known = (await databaseZones()).has(stored.toLowerCase()) && canonicalTimezone(stored) !== null;
  return known ? { timezone: stored, fallback: false } : { timezone: 'UTC', fallback: true };
}

/** Forget the cached list (tests). */
export function __resetTimezoneCacheForTests(): void {
  names = null;
}
