/**
 * What a custom template must satisfy, on save and on publish.
 *
 * Save checks the shape (key, names, domains). Publish checks the content
 * against its own schema, because publishing is what makes a template
 * sendable and a mistake found then costs one click, not a customer's inbox.
 */

import {
  CUSTOM_EMAIL_MAX_LINK_DOMAINS,
  CUSTOM_EMAIL_MAX_VARIABLES,
  CUSTOM_EMAIL_TEMPLATE_KEY_RE,
  CustomEmailVariableDefSchema,
  type CustomEmailVariableDef,
} from '@rekey.dev/shared-types';
import { z } from 'zod';
import { isKnownEvent } from '../events.js';
import type { VariableIssue } from './variables.js';

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A display name that cannot smuggle an address or a header into `From:`. */
const FROM_NAME_RE = /^[^<>@"\r\n]{1,120}$/;

export const TemplateKeySchema = z
  .string()
  .regex(CUSTOM_EMAIL_TEMPLATE_KEY_RE, 'must be 3 to 64 characters of a-z, 0-9 and _, starting with a letter.')
  .refine((k) => !isKnownEvent(k), 'is the key of a built-in email. Pick another key.');

export const VariableSchemaSchema = z
  .array(CustomEmailVariableDefSchema)
  .max(CUSTOM_EMAIL_MAX_VARIABLES)
  .refine((defs) => new Set(defs.map((d) => d.name)).size === defs.length, 'variable names must be unique.');

export const LinkDomainsSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(HOSTNAME_RE, 'must be a hostname such as links.example.com, without a scheme or path.'),
  )
  .max(CUSTOM_EMAIL_MAX_LINK_DOMAINS)
  .transform((domains) => [...new Set(domains)]);

export const FromNameSchema = z
  .string()
  .regex(FROM_NAME_RE, 'must be 1 to 120 characters with no <, >, @, quotes or line breaks.');

const TOKEN_RE = /\{\{(\w+)\}\}/g;
const SECTION_RE = /\{\{#if\s+(\w+)\}\}/g;
/** Attributes whose value the mail client treats as an address. */
const URL_ATTR_RE =
  /\b(?:href|src|srcset|background|action|formaction|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
const SECTION_MARKER_RE = /\{\{#if\s+\w+\}\}|\{\{\/if\}\}/g;
/**
 * Text that already fixes where an address points: a full scheme and host
 * followed by a path, query or fragment; a relative path; a fragment or query
 * on the current page; or a mailto/tel link. A variable after this cannot move
 * the link to another scheme or host.
 */
const FIXED_ORIGIN_RE = /^\s*(?:[a-z][a-z0-9+.-]*:\/\/[^/?#\s{}]+[/?#]|\/(?!\/)|\.{1,2}\/|#|\?|mailto:|tel:)/i;

/** Every address in the HTML: URL attributes (srcset split per candidate) and CSS url(). */
function urlValues(html: string): string[] {
  const values: string[] = [];
  for (const m of html.matchAll(URL_ATTR_RE)) {
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    const isSrcset = /^\s*srcset/i.test(m[0]);
    values.push(...(isSrcset ? value.split(',') : [value]));
  }
  for (const m of html.matchAll(CSS_URL_RE)) values.push(m[1] ?? m[2] ?? m[3] ?? '');
  return values;
}

/** Variables placed where they decide an address's scheme or host. */
function originVariables(html: string): string[] {
  const names: string[] = [];
  for (const raw of urlValues(html)) {
    const value = raw.replace(SECTION_MARKER_RE, '');
    for (const m of value.matchAll(TOKEN_RE)) {
      if (!FIXED_ORIGIN_RE.test(value.slice(0, m.index))) names.push(m[1]!);
    }
  }
  return names;
}

function referencedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) names.add(m[1]!);
  for (const m of text.matchAll(SECTION_RE)) names.add(m[1]!);
  return names;
}

/**
 * Names the subject or bodies use that `variableSchema` does not declare, in
 * order of first use.
 *
 * @example
 * ```ts
 * undeclaredNames({ subject: 'Order {{orderId}} shipped', bodyHtml: '', bodyText: null, variableSchema: [] });
 * // ['orderId']
 * ```
 */
export function undeclaredNames(input: {
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  variableSchema: readonly CustomEmailVariableDef[];
}): string[] {
  const declared = new Set(input.variableSchema.map((d) => d.name));
  const used = new Set([
    ...referencedNames(input.subject),
    ...referencedNames(input.bodyHtml),
    ...referencedNames(input.bodyText ?? ''),
  ]);
  return [...used].filter((name) => !declared.has(name));
}

/**
 * Content rules checked at publish. Returns every problem found.
 *
 * - Every `{{var}}` and `{{#if var}}` is declared, so a typo cannot ship as an
 *   empty string.
 * - A variable that decides an address's scheme or host (in href, src, srcset,
 *   background, action, formaction, poster, xlink:href or CSS url()) is a `url`.
 *   Escaping keeps a value inside the attribute, but not `javascript:` or
 *   another host when the value decides where the link goes; `url` variables
 *   are https and allow-listed.
 * - A `url` variable has somewhere it is allowed to point.
 */
export function publishIssues(input: {
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  variableSchema: readonly CustomEmailVariableDef[];
  linkDomains: readonly string[];
}): VariableIssue[] {
  const issues: VariableIssue[] = [];
  const byName = new Map(input.variableSchema.map((d) => [d.name, d]));
  const sources: Array<[string, string]> = [
    ['subject', input.subject],
    ['bodyHtml', input.bodyHtml],
    ['bodyText', input.bodyText ?? ''],
  ];
  for (const [path, text] of sources) {
    for (const name of referencedNames(text)) {
      if (!byName.has(name)) {
        issues.push({ path, message: `uses {{${name}}}, which is not declared in variableSchema.` });
      }
    }
  }
  for (const name of new Set(originVariables(input.bodyHtml))) {
    const def = byName.get(name);
    if (def !== undefined && def.type !== 'url') {
      issues.push({
        path: 'bodyHtml',
        message:
          `uses {{${def.name}}} where it decides the scheme or host of a link or image address. ` +
          'Declare it with type "url", or write the fixed address before it (https://example.com/...).',
      });
    }
  }
  if (input.variableSchema.some((d) => d.type === 'url') && input.linkDomains.length === 0) {
    issues.push({ path: 'linkDomains', message: 'needs at least one hostname, because a variable has type "url".' });
  }
  return issues;
}
