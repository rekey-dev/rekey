/**
 * Reading and editing one end user's profile answers in the panel.
 */

import type { ProfileField } from '@rekey.dev/shared-types';

type Answers = Record<string, string | number | boolean>;

/**
 * Whether the user answered `key`. An own property only: `{}` has a
 * `constructor` through its prototype, and that is not an answer.
 */
export function isAnswered(answers: Answers | undefined, key: string): boolean {
  return answers !== undefined && Object.hasOwn(answers, key);
}

/** A select answer that is not among the field's options any more. */
export function isRetiredOption(field: ProfileField, value: string | number | boolean | undefined): boolean {
  return field.type === 'select' && value !== undefined && !(field.options ?? []).includes(String(value));
}

/** The edit dialog's form arrived without a readable list of field types. */
export class ProfileFormError extends Error {
  readonly code = 'PROFILE_FORM_INVALID';
  constructor() {
    super('The answers form arrived without its field types, so nothing could be saved.');
  }
}

/** The dialog's hidden `types` field: an object of field key to field type, or null. */
function readTypes(formData: FormData): Record<string, string> | null {
  const raw = formData.get('types');
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  return entries.every(([, t]) => typeof t === 'string') ? (parsed as Record<string, string>) : null;
}

/**
 * The patch for the operator's edit dialog: only the fields whose input
 * differs from the value the dialog was rendered with (`o_<key>`), so an
 * answer the user gave meanwhile, or a select answer that is no longer an
 * option, is never overwritten by a field the operator did not touch. An
 * emptied input clears the answer; numbers and booleans are typed. Throws
 * `ProfileFormError` when the form's field types are missing or unreadable,
 * rather than returning an empty patch the page would report as saved.
 *
 * @example
 *   answersPatch(formData) // { company: 'Acme Ltd' }
 */
export function answersPatch(formData: FormData): Record<string, unknown> {
  const types = readTypes(formData);
  if (types === null) throw new ProfileFormError();
  const patch: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(types)) {
    const raw = String(formData.get(`f_${key}`) ?? '').trim();
    const original = String(formData.get(`o_${key}`) ?? '').trim();
    if (raw === original) continue;
    if (raw === '') patch[key] = null;
    else if (type === 'number') patch[key] = Number(raw);
    else if (type === 'boolean') patch[key] = raw === 'true';
    else patch[key] = raw;
  }
  return patch;
}
