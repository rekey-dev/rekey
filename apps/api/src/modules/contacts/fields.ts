/**
 * What a subscribe may carry beyond the address: checked against the list's
 * field schema, normalised, and trimmed down to what is safe to store.
 */

import { maskIp } from '../../lib/ip-mask.js';
import { z } from 'zod';
import { CONTACT_FIELDS_MAX_BYTES, type ContactFieldDef } from '@rekey.dev/shared-types';
import { fieldsInvalid } from './errors.js';

type FieldValue = string | number | boolean;
type Issue = { path: string; message: string };

const email = z.string().email();

/** What an HTML checkbox or a hand-built form posts for a checkbox field. */
const CHECKBOX_STRINGS: Record<string, boolean> = { on: true, true: true, false: false, off: false };

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function checkOne(def: ContactFieldDef, raw: FieldValue, issues: Issue[]): FieldValue | undefined {
  const path = `fields.${def.name}`;
  const fail = (message: string): undefined => {
    issues.push({ path, message });
    return undefined;
  };
  if (def.type === 'checkbox') {
    if (typeof raw === 'boolean') return raw;
    const flag = CHECKBOX_STRINGS[String(raw).toLowerCase()];
    return flag ?? fail('Must be true or false.');
  }
  if (def.type === 'number') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : fail('Must be a number.');
  }
  if (typeof raw !== 'string') return fail('Must be text.');
  const value = raw.trim();
  if (value.length > def.maxLength) return fail(`At most ${def.maxLength} characters.`);
  if (def.type === 'email' && !email.safeParse(value).success) return fail('Must be an email address.');
  if (def.type === 'url' && !isHttpUrl(value)) return fail('Must be an http or https URL.');
  if (def.type === 'select' && !def.options?.includes(value)) {
    return fail(`Must be one of: ${def.options?.join(', ') ?? ''}.`);
  }
  return value;
}

function isBlank(value: FieldValue | undefined): boolean {
  return value === undefined || (typeof value === 'string' && value.trim() === '');
}

/**
 * Validate `fields` against the schema. Unknown names, missing required
 * fields, wrong types and oversize bodies are all reported together in one
 * `CONTACT_FIELDS_INVALID`. Empty optional fields are dropped.
 */
export function validateFields(
  schema: ContactFieldDef[],
  input: Record<string, FieldValue> | undefined,
): Record<string, FieldValue> {
  const fields = input ?? {};
  const issues: Issue[] = [];
  const known = new Map(schema.map((def) => [def.name, def]));
  for (const name of Object.keys(fields)) {
    if (!known.has(name)) issues.push({ path: `fields.${name}`, message: 'This list has no such field.' });
  }
  const out: Record<string, FieldValue> = {};
  for (const def of schema) {
    const raw = fields[def.name];
    if (isBlank(raw)) {
      if (def.required) issues.push({ path: `fields.${def.name}`, message: 'Required.' });
      continue;
    }
    const value = checkOne(def, raw!, issues);
    if (value !== undefined) out[def.name] = value;
  }
  if (Buffer.byteLength(JSON.stringify(out)) > CONTACT_FIELDS_MAX_BYTES) {
    issues.push({ path: 'fields', message: `At most ${CONTACT_FIELDS_MAX_BYTES} bytes in total.` });
  }
  if (issues.length > 0) throw fieldsInvalid(issues);
  return out;
}

/** The page a form was on: origin and path only, so no query string or fragment is stored. */
export function sourceUrlOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return null;
  }
}

/** IPv4 to its /24, IPv6 to its /48 (lib/ip-mask.ts). The full address is never stored with consent. */
export const ipPrefixOf = (ip: string | null): string | null => maskIp(ip);
