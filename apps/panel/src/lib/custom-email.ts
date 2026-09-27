/**
 * Form parsing for the Custom templates tab. Kept out of the pages so the
 * rules are unit-testable; the API re-validates everything.
 */

import {
  CUSTOM_EMAIL_MAX_LINK_DOMAINS,
  CUSTOM_EMAIL_MAX_VARIABLES,
  CUSTOM_EMAIL_TEMPLATE_KEY_RE,
  CustomEmailVariableDefSchema,
  type CustomEmailVariableDef,
} from '@rekey.dev/shared-types';

export interface CustomEmailSettings {
  eligible: boolean;
  transport: 'byo_resend' | 'byo_smtp' | 'default_resend' | 'none';
  fromAddress: string | null;
  recipientsMustBeEndUsers: boolean;
  caps: { daily: number; recipientHourly: number };
}

/** Why custom templates cannot be sent from this Application, or null when they can. */
export function ineligibleReason(settings: Pick<CustomEmailSettings, 'eligible' | 'transport'>): string | null {
  if (settings.eligible) return null;
  return settings.transport === 'default_resend'
    ? 'This Application sends through the shared pool, which custom templates never use. Connect your own Resend or SMTP in Settings to use custom templates.'
    : 'This Application has no email provider yet. Connect your own Resend or SMTP in Settings to use custom templates.';
}

export function isTemplateKey(key: string): boolean {
  return CUSTOM_EMAIL_TEMPLATE_KEY_RE.test(key);
}

/**
 * The variable editor posts its rows as JSON in one hidden field. Returns the
 * parsed definitions, or the first problem in words.
 *
 * @example
 * ```ts
 * parseVariableSchema('[{"name":"orderNumber","type":"string","required":true}]');
 * ```
 */
export function parseVariableSchema(
  raw: string,
): { ok: true; defs: CustomEmailVariableDef[] } | { ok: false; error: string } {
  if (raw.trim() === '') return { ok: true, defs: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'The variable list could not be read. Reload the page and try again.' };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'The variable list could not be read.' };
  const rows = parsed.filter(
    (r) => !(typeof r === 'object' && r !== null && String((r as { name?: unknown }).name ?? '').trim() === ''),
  );
  if (rows.length > CUSTOM_EMAIL_MAX_VARIABLES) {
    return { ok: false, error: `A template can declare at most ${CUSTOM_EMAIL_MAX_VARIABLES} variables.` };
  }
  const defs: CustomEmailVariableDef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const result = CustomEmailVariableDefSchema.safeParse(row);
    const name = String((row as { name?: unknown }).name ?? '');
    if (!result.success) {
      return {
        ok: false,
        error: `"${name}" is not a valid variable: names start with a letter and use letters, digits and _; max length is 1 to 2048.`,
      };
    }
    if (seen.has(result.data.name)) return { ok: false, error: `"${result.data.name}" is declared twice.` };
    seen.add(result.data.name);
    defs.push(result.data);
  }
  return { ok: true, defs };
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** One hostname per line (commas and spaces also separate). */
export function parseLinkDomains(raw: string): { domains: string[]; invalid: string[] } {
  const entries = raw
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    if (HOSTNAME_RE.test(entry)) {
      if (!domains.includes(entry)) domains.push(entry);
    } else {
      invalid.push(entry);
    }
  }
  if (domains.length > CUSTOM_EMAIL_MAX_LINK_DOMAINS) {
    invalid.push(`more than ${CUSTOM_EMAIL_MAX_LINK_DOMAINS} hostnames`);
  }
  return { domains, invalid };
}

/** The starting body of a new template, so the editor opens on something. */
export function starterHtml(variables: readonly CustomEmailVariableDef[]): string {
  const lines = variables.map((v) =>
    v.type === 'url' ? `<p><a href="{{${v.name}}}">{{${v.name}}}</a></p>` : `<p>{{${v.name}}}</p>`,
  );
  return `<p>Write your email here.</p>${lines.join('')}`;
}

const UNDECLARED_MARK_STYLE = 'background:#fde68a;color:#78350f;padding:0 2px;border-radius:2px';

function tokenPattern(names: readonly string[]): RegExp | null {
  const safe = names.filter((n) => /^\w+$/.test(n));
  if (safe.length === 0) return null;
  return new RegExp(`\\{\\{(?:${safe.join('|')})\\}\\}`, 'g');
}

/**
 * Highlight the `{{name}}` tokens the preview left in place for undeclared
 * variables. Only text between tags is touched, so an attribute value that
 * holds a token is left alone rather than broken.
 *
 * @example
 * markUndeclared('<p>Order {{orderId}}</p>', ['orderId']);
 * // '<p>Order <mark style="...">{{orderId}}</mark></p>'
 */
export function markUndeclared(html: string, names: readonly string[]): string {
  const pattern = tokenPattern(names);
  if (pattern === null) return html;
  return html
    .split(/(<[^>]*>)/)
    .map((part) =>
      part.startsWith('<')
        ? part
        : part.replace(pattern, (token) => `<mark style="${UNDECLARED_MARK_STYLE}">${token}</mark>`),
    )
    .join('');
}

/**
 * Split a rendered subject into plain text and undeclared `{{name}}` tokens.
 *
 * @example
 * splitUndeclared('Your order {{orderId}} shipped', ['orderId']);
 * // [{ text: 'Your order ', undeclared: false }, { text: '{{orderId}}', undeclared: true }, { text: ' shipped', undeclared: false }]
 */
export function splitUndeclared(text: string, names: readonly string[]): Array<{ text: string; undeclared: boolean }> {
  const pattern = tokenPattern(names);
  if (pattern === null) return [{ text, undeclared: false }];
  const parts: Array<{ text: string; undeclared: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), undeclared: false });
    parts.push({ text: m[0], undeclared: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), undeclared: false });
  return parts;
}
