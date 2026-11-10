/**
 * Profile answers read from a submitted form, checked by the rules the API
 * applies (`apps/api/src/modules/end-users/profile-values.ts`), so a wrong
 * answer is named next to its field instead of failing the whole save. The
 * profile page and the first-run questions both read their forms here.
 *
 * Pure and runtime-neutral: the server actions, the inputs and tests import it.
 */

import type { EndUserProfile, ProfileField, ProfileValue } from '@rekey.dev/shared-types';
import { MAX_PROFILE_TEXT } from '@rekey.dev/shared-types/profile-limits';

/** The form name of a field's input. */
export function profileInputName(key: string): string {
  return `profile.${key}`;
}

/** Raw input text per field key, so a refused form shows what was typed. */
export type ProfileDraft = Record<string, string>;

export type ProfileFormRead = {
  /** Answers to send: a value, or null to clear. Only fields that changed. */
  patch: Record<string, ProfileValue | null>;
  /** Message per field key for an answer the API would refuse. */
  errors: Record<string, string>;
  draft: ProfileDraft;
};

export const PROFILE_ANSWER_COPY = {
  required: 'Answer this question to continue.',
  text: `Use at most ${MAX_PROFILE_TEXT} characters.`,
  option: 'Choose one of the options.',
  number: 'Enter a number.',
  boolean: 'Choose yes or no.',
  url: 'Enter a web address that starts with https:// or http://.',
  date: 'Enter a real date.',
} as const;

const MAX_URL = 2048;

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function isHttpUrl(value: string): boolean {
  if (value.length > MAX_URL) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function parse(field: ProfileField, raw: string): { value: ProfileValue | null } | { error: string } {
  const text = raw.trim();
  if (text === '') return { value: null };
  switch (field.type) {
    case 'select':
      return field.options?.includes(text) ? { value: text } : { error: PROFILE_ANSWER_COPY.option };
    case 'number': {
      const n = Number(text);
      return Number.isFinite(n) ? { value: n } : { error: PROFILE_ANSWER_COPY.number };
    }
    case 'boolean':
      return text === 'true' ? { value: true } : text === 'false' ? { value: false } : { error: PROFILE_ANSWER_COPY.boolean };
    case 'url':
      return isHttpUrl(text) ? { value: text } : { error: PROFILE_ANSWER_COPY.url };
    case 'date':
      return isRealDate(text) ? { value: text } : { error: PROFILE_ANSWER_COPY.date };
    default:
      return text.length > MAX_PROFILE_TEXT ? { error: PROFILE_ANSWER_COPY.text } : { value: text };
  }
}

/**
 * Required questions with no stored answer, in schema order. Only fields the
 * customer may answer count: the publishable key is served no other kind.
 *
 * @example
 * outstandingProfileFields([{ key: 'team', requiredForOnboarding: true, ... }], {}); // [{ key: 'team', ... }]
 */
export function outstandingProfileFields(
  fields: readonly ProfileField[],
  profile: Record<string, unknown> | undefined,
): ProfileField[] {
  return fields.filter(
    (f) => f.requiredForOnboarding && f.writableBy === 'user' && !Object.hasOwn(profile ?? {}, f.key),
  );
}

/** The text an input shows for a stored answer. */
export function draftOf(fields: readonly ProfileField[], values: EndUserProfile): ProfileDraft {
  return Object.fromEntries(
    fields.map((f) => {
      const v = Object.prototype.hasOwnProperty.call(values, f.key) ? values[f.key] : undefined;
      return [f.key, v === undefined ? '' : String(v)];
    }),
  );
}

/**
 * Reads every field's input. With `requireOnboarding`, an empty answer to a
 * `requiredForOnboarding` field is refused, as the first-run questions need.
 *
 * @example
 * readProfileForm([{ key: 'age', type: 'number', ... }], {}, formWith({ 'profile.age': '41' }));
 * // { patch: { age: 41 }, errors: {}, draft: { age: '41' } }
 */
export function readProfileForm(
  fields: readonly ProfileField[],
  stored: EndUserProfile,
  formData: FormData,
  { requireOnboarding = false }: { requireOnboarding?: boolean } = {},
): ProfileFormRead {
  const patch: Record<string, ProfileValue | null> = {};
  const errors: Record<string, string> = {};
  const draft: ProfileDraft = {};
  const before = draftOf(fields, stored);
  for (const field of fields) {
    const raw = formData.get(profileInputName(field.key));
    const text = typeof raw === 'string' ? raw : '';
    draft[field.key] = text;
    if (requireOnboarding && field.requiredForOnboarding && text.trim() === '') {
      errors[field.key] = PROFILE_ANSWER_COPY.required;
      continue;
    }
    const result = parse(field, text);
    if ('error' in result) errors[field.key] = result.error;
    else if (text.trim() !== before[field.key]) patch[field.key] = result.value;
  }
  return { patch, errors, draft };
}
