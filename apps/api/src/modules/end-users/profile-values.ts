import {
  MAX_PROFILE_TEXT,
  ProfileSchemaSchema,
  type EndUserProfile,
  type ProfileField,
  type ProfileValue,
} from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';

/** Most bytes one user's stored answers may take, measured after the merge. */
export const MAX_PROFILE_BYTES = 16 * 1024;
const MAX_URL = 2048;

/** Who is writing: the signed-in user, or a secret key / operator. */
export type ProfileWriter = 'user' | 'server';

/**
 * The stored profile schema, read leniently: a row that no longer parses (an
 * older shape, a hand edit) reads as no fields rather than breaking every
 * profile read.
 *
 * @example
 *   const fields = readProfileSchema(application.profileSchema);
 */
export function readProfileSchema(raw: unknown): ProfileField[] {
  const parsed = ProfileSchemaSchema.safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}

/** The stored answers as an object, whatever the column holds. */
export function readProfile(raw: unknown): EndUserProfile {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as EndUserProfile) } : {};
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function isHttpUrl(value: string): boolean {
  if (value.length > MAX_URL) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** The value to store for `field`, or the reason it is refused. */
function coerce(field: ProfileField, value: unknown): { ok: ProfileValue } | { issue: string } {
  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string') return { issue: 'Expected a string.' };
      const trimmed = value.trim();
      if (trimmed === '') return { issue: 'Send null to clear the answer instead of an empty string.' };
      if (trimmed.length > MAX_PROFILE_TEXT) return { issue: `At most ${MAX_PROFILE_TEXT} characters.` };
      return { ok: trimmed };
    }
    case 'select':
      return typeof value === 'string' && field.options!.includes(value)
        ? { ok: value }
        : { issue: `Expected one of: ${field.options!.join(', ')}.` };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? { ok: value } : { issue: 'Expected a number.' };
    case 'boolean':
      return typeof value === 'boolean' ? { ok: value } : { issue: 'Expected true or false.' };
    case 'url':
      return typeof value === 'string' && isHttpUrl(value)
        ? { ok: value }
        : { issue: `Expected an http(s) URL of at most ${MAX_URL} characters.` };
    case 'date':
      return typeof value === 'string' && isRealDate(value) ? { ok: value } : { issue: 'Expected a date as YYYY-MM-DD.' };
  }
}

/**
 * Apply a patch of answers to a stored profile. A key set to `null` clears
 * that answer; keys not in the patch are kept. Refuses, before changing
 * anything: a key the schema does not define, a `server` field written by the
 * user, an answer of the wrong shape, and a result over 16 KB. Returns the new
 * profile and the keys whose answer actually changed.
 *
 * @example
 *   const { profile, changed } = applyProfilePatch(fields, stored, { company: 'Acme' }, 'user');
 */
export function applyProfilePatch(
  fields: readonly ProfileField[],
  stored: EndUserProfile,
  patch: Record<string, unknown>,
  writer: ProfileWriter,
): { profile: EndUserProfile; changed: string[] } {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const unknown = Object.keys(patch).filter((k) => !byKey.has(k));
  if (unknown.length > 0) {
    throw new RekeyError({
      statusCode: 400,
      code: 'PROFILE_FIELD_UNKNOWN',
      message: `This Application defines no profile field ${unknown.map((k) => `"${k}"`).join(', ')}.`,
      fix: 'Define the field with PUT /api/v1/tenant/applications/:id/profile-schema, or remove it from the request.',
      details: { unknown, defined: fields.map((f) => f.key) },
    });
  }
  if (writer === 'user') {
    const readOnly = Object.keys(patch).filter((k) => byKey.get(k)!.writableBy === 'server');
    if (readOnly.length > 0) {
      throw new RekeyError({
        statusCode: 403,
        code: 'PROFILE_FIELD_READ_ONLY',
        message: `${readOnly.map((k) => `"${k}"`).join(', ')} can only be set by your server or an operator.`,
        fix: 'Set it with a secret key (PATCH /api/v1/users/:id/profile, rekey.users.updateProfile) or as an operator, or change the field to writableBy "user".',
        details: { fields: readOnly },
      });
    }
  }

  const issues: Array<{ key: string; message: string }> = [];
  const profile = { ...stored };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete profile[key];
      continue;
    }
    const result = coerce(byKey.get(key)!, value);
    if ('issue' in result) issues.push({ key, message: result.issue });
    else profile[key] = result.ok;
  }
  if (issues.length > 0) {
    throw new RekeyError({
      statusCode: 400,
      code: 'PROFILE_FIELD_INVALID',
      message: `Invalid answer for ${issues.map((i) => `"${i.key}"`).join(', ')}.`,
      fix: 'Send each answer in the shape its field type takes; `details.issues` says what each field expected.',
      details: { issues },
    });
  }
  if (Buffer.byteLength(JSON.stringify(profile), 'utf8') > MAX_PROFILE_BYTES) {
    throw new RekeyError({
      statusCode: 400,
      code: 'PROFILE_TOO_LARGE',
      message: `The profile would exceed ${MAX_PROFILE_BYTES / 1024} KB after this update.`,
      fix: 'Send shorter answers, or clear answers you no longer need by setting them to null.',
    });
  }
  const changed = Object.keys(patch).filter(
    (k) => Object.hasOwn(profile, k) !== Object.hasOwn(stored, k) || profile[k] !== stored[k],
  );
  return { profile, changed };
}

/**
 * Keys of required fields the profile has no answer for, in schema order.
 *
 * @example
 *   missingRequired(fields, user.profile) // ['team_size']
 */
export function missingRequired(fields: readonly ProfileField[], profile: EndUserProfile): string[] {
  return fields.filter((f) => f.requiredForOnboarding && !Object.hasOwn(profile, f.key)).map((f) => f.key);
}
