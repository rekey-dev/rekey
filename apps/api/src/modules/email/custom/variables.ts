/**
 * Checking the values a send supplies against a custom template's declared
 * variables. Everything the caller controls in a custom email passes through
 * here, so the rules are strict: undeclared names are refused rather than
 * dropped, and a `url` may only point at the template's own link domains.
 */

import {
  CUSTOM_EMAIL_MAX_VARIABLES,
  CustomEmailVariableDefSchema,
  type CustomEmailVariableDef,
} from '@rekey.dev/shared-types';
import { z } from 'zod';

export interface VariableIssue {
  path: string;
  message: string;
}

const StoredSchema = z.array(CustomEmailVariableDefSchema);

/** Read a stored `variableSchema` column. It was validated on write. */
export function readVariableSchema(raw: unknown): CustomEmailVariableDef[] {
  return StoredSchema.parse(raw);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value) && !ISO_DATE_TIME_RE.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/** Why a URL value is refused, or null when it is allowed. */
export function urlProblem(value: string, linkDomains: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute https URL.';
  }
  if (url.protocol !== 'https:') return 'must use https.';
  if (url.username !== '' || url.password !== '') return 'must not contain credentials.';
  const host = url.hostname.toLowerCase();
  if (!linkDomains.includes(host)) {
    return linkDomains.length === 0
      ? 'cannot be used: this template has no link domains.'
      : `must point at one of this template's link domains (${linkDomains.join(', ')}).`;
  }
  return null;
}

/** The value as it is substituted, or an issue. `null` means absent. */
function stringForm(def: CustomEmailVariableDef, value: unknown): string | { problem: string } | null {
  if (value === undefined || value === null || value === '') return null;
  switch (def.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { problem: 'must be a finite number.' };
      return String(value);
    case 'string':
    case 'url':
    case 'date':
      if (typeof value !== 'string') return { problem: 'must be a string.' };
      return value;
  }
}

/**
 * Validate supplied values and return them as strings ready to render.
 * Every problem is reported, not just the first, so one round trip fixes all.
 *
 * @example
 * ```ts
 * const { values, issues } = validateVariables(schema, ['track.example.com'], {
 *   trackingUrl: 'https://track.example.com/A-1042',
 * });
 * ```
 */
export function validateVariables(
  schema: readonly CustomEmailVariableDef[],
  linkDomains: readonly string[],
  supplied: Record<string, unknown>,
): { values: Record<string, string>; issues: VariableIssue[] } {
  const issues: VariableIssue[] = [];
  const values: Record<string, string> = {};
  const declared = new Map(schema.map((d) => [d.name, d]));

  const suppliedNames = Object.keys(supplied);
  if (suppliedNames.length > CUSTOM_EMAIL_MAX_VARIABLES) {
    issues.push({ path: 'variables', message: `at most ${CUSTOM_EMAIL_MAX_VARIABLES} variables.` });
  }
  for (const name of suppliedNames) {
    if (!declared.has(name)) {
      issues.push({ path: `variables.${name}`, message: 'is not declared by this template.' });
    }
  }

  for (const def of schema) {
    const path = `variables.${def.name}`;
    const form = stringForm(def, supplied[def.name]);
    if (form === null) {
      if (def.required) issues.push({ path, message: 'is required.' });
      values[def.name] = '';
      continue;
    }
    if (typeof form !== 'string') {
      issues.push({ path, message: form.problem });
      continue;
    }
    if (form.length > def.maxLength) {
      issues.push({ path, message: `must be at most ${def.maxLength} characters.` });
      continue;
    }
    if (def.type === 'date' && !isIsoDate(form)) {
      issues.push({ path, message: 'must be an ISO 8601 date (2026-09-26) or date-time with an offset.' });
      continue;
    }
    if (def.type === 'url') {
      const problem = urlProblem(form, linkDomains);
      if (problem !== null) {
        issues.push({ path, message: problem });
        continue;
      }
    }
    values[def.name] = form;
  }
  return { values, issues };
}

/**
 * Check preview values with the same rules a send applies, minus `required`:
 * a preview may leave any variable to its sample.
 */
export function overrideIssues(
  schema: readonly CustomEmailVariableDef[],
  linkDomains: readonly string[],
  overrides: Record<string, unknown>,
): VariableIssue[] {
  const optional = schema.map((def) => ({ ...def, required: false }));
  return validateVariables(optional, linkDomains, overrides).issues;
}

/** Sample values for the preview and test send: the declared sample, or a typed placeholder. */
export function sampleValues(
  schema: readonly CustomEmailVariableDef[],
  linkDomains: readonly string[],
  overrides: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of schema) {
    const given = overrides[def.name] ?? def.sample;
    if (given !== undefined) {
      out[def.name] = given.slice(0, def.maxLength);
      continue;
    }
    switch (def.type) {
      case 'number':
        out[def.name] = '42';
        break;
      case 'date':
        out[def.name] = new Date().toISOString().slice(0, 10);
        break;
      case 'url':
        out[def.name] = `https://${linkDomains[0] ?? 'example.com'}/`;
        break;
      case 'string':
        out[def.name] = `[${def.name}]`;
        break;
    }
  }
  return out;
}
