import { z } from 'zod';

/** Zone names that are UTC under another name. They are stored as `UTC`. */
const UTC_ALIASES = new Set([
  'utc',
  'etc/utc',
  'etc/uct',
  'uct',
  'etc/universal',
  'universal',
  'etc/zulu',
  'zulu',
  'gmt',
  'etc/gmt',
  'etc/gmt0',
  'etc/gmt+0',
  'etc/gmt-0',
  'gmt0',
  'gmt+0',
  'gmt-0',
  'etc/greenwich',
  'greenwich',
]);

function resolved(value: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) return null;
  try {
    return Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * The name a zone is stored under: `UTC` for every alias of it, otherwise the
 * `Area/Location` name as given, once the runtime's Intl accepts it. It is not
 * rewritten to ICU's canonical spelling: ICU keeps legacy names
 * (`Asia/Kolkata` resolves to `Asia/Calcutta`) that Postgres does not know.
 * The API also checks the name against the database's zone list. Null for
 * anything that is not an `Area/Location` zone (`IST`, `EST5EDT`, unknown).
 *
 * @example
 *   canonicalTimezone('Asia/Kolkata') // 'Asia/Kolkata'
 *   canonicalTimezone('Etc/UTC') // 'UTC'
 *   canonicalTimezone('IST') // null
 */
export function canonicalTimezone(value: string): string | null {
  const trimmed = value.trim();
  if (UTC_ALIASES.has(trimmed.toLowerCase())) return 'UTC';
  if (!trimmed.includes('/')) return null;
  const name = resolved(trimmed);
  if (!name) return null;
  return UTC_ALIASES.has(name.toLowerCase()) ? 'UTC' : trimmed;
}

/**
 * True for a zone name the runtime's Intl knows, `UTC` and its aliases included.
 *
 * @example
 *   isIanaTimezone('Asia/Kolkata') // true
 *   isIanaTimezone('IST') // false
 */
export function isIanaTimezone(value: string): boolean {
  return canonicalTimezone(value) !== null;
}

/** An Application's reporting timezone, read as its canonical IANA name (`Europe/Berlin`, `UTC`). */
export const ReportingTimezoneSchema = z
  .string()
  .refine(isIanaTimezone, 'Use an IANA timezone name such as UTC, Europe/Berlin or Asia/Kolkata.')
  .transform((v) => canonicalTimezone(v) as string);

/** `PATCH /api/v1/tenant/applications/:id/settings`. */
export const ApplicationSettingsPatchSchema = z
  .object({
    reportingTimezone: ReportingTimezoneSchema.optional(),
  })
  .strict();
export type ApplicationSettingsPatch = z.infer<typeof ApplicationSettingsPatchSchema>;
