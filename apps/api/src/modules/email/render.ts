/**
 * Template rendering: `{{var}}` substitution with mandatory HTML-escape.
 *
 * This is the chokepoint that prevents stored-template-XSS. Every variable
 * value is HTML-escaped before being interpolated into the template body;
 * raw HTML in a variable value is never rendered as markup.
 *
 * The template body itself is operator-authored markup. It runs through
 * the substituter as-is — the trust model is "the operator wrote this and
 * is responsible for its safety." We only neutralise the *runtime
 * variables* the system supplies.
 *
 * Plain-text alternatives use the same substitution but without escaping,
 * since text/plain has no markup to escape.
 */

import { isKnownEvent, EMAIL_EVENTS, type EmailEventKey } from './events.js';

const TOKEN_RE = /\{\{(\w+)\}\}/g;

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]!);
}

/**
 * Substitute `{{var}}` occurrences in `template`. Unknown variables are
 * replaced with empty string (never the literal token), so a template
 * authored against an older variable set degrades gracefully.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string>,
  options: { escape: boolean },
): string {
  return template.replace(TOKEN_RE, (_match, name: string) => {
    const value = variables[name] ?? '';
    return options.escape ? htmlEscape(value) : value;
  });
}

/**
 * Validate that the supplied `variables` cover every name the event
 * declares. Extra names are dropped silently — the registry is the
 * source of truth. Missing names render as empty strings (no throw),
 * which is the right call for "compatible with older templates."
 */
export function pickEventVariables(
  eventKey: string,
  supplied: Record<string, unknown>,
): Record<string, string> {
  if (!isKnownEvent(eventKey)) return {};
  const allowed = EMAIL_EVENTS[eventKey].variables;
  const out: Record<string, string> = {};
  for (const name of allowed) {
    const v = supplied[name];
    out[name] = typeof v === 'string' ? v : v == null ? '' : String(v);
  }
  return out;
}

/**
 * Cheap HTML → plain-text fallback. Strips tags, decodes a small set of
 * entities, collapses whitespace. Good enough for the text/plain alt;
 * customers who care can supply a hand-authored plain-text body.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>(?=\s*)/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
