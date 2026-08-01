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

/**
 * `{{#if var}}…{{/if}}` — the ONLY control structure the engine has, and
 * deliberately the smallest one that solves the problem it was added for:
 * a call-to-action button whose URL cannot be resolved must not render at
 * all. `{{appUrl}}` substituted with the empty string yields `href=""`,
 * which is a broken link wearing a different hat.
 *
 * Semantics, kept boring on purpose:
 *   - Truthy means "a non-empty string after trimming." No coercion games.
 *   - Non-greedy up to the FIRST `{{/if}}`, so sections do not nest. A
 *     nested `{{#if}}` closes on its parent's tag; don't write one.
 *   - There is no `{{else}}`, no negation, no comparison, no expression
 *     evaluation. Anything more and the operator-authored template body
 *     stops being inert markup, which is the property that keeps the
 *     stored-XSS story simple.
 *   - An unmatched `{{#if}}` (no closing tag) is left verbatim rather than
 *     swallowing the rest of the document.
 */
const SECTION_RE = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;

/**
 * Anchors whose href resolved to empty, e.g. `<a href="">Get started</a>`.
 *
 * This is the backstop for templates the conditional syntax can't reach:
 * an `EmailTemplate` row an operator saved BEFORE `{{#if}}` existed still
 * contains a bare `href="{{appUrl}}"`, and no amount of new template syntax
 * retroactively edits their stored HTML. Rather than leave those rows
 * emitting dead links, the rendered output is swept and any empty-href
 * anchor collapses to its own text content.
 *
 * Safe against injection: variable values are HTML-escaped before this runs,
 * so a value can never contribute a literal `"` and forge an href boundary.
 * Anchors cannot nest in valid HTML, so the non-greedy body match is sound.
 */
const EMPTY_HREF_ANCHOR_RE = /<a\b[^>]*?\bhref\s*=\s*(?:""|'')[^>]*>([\s\S]*?)<\/a\s*>/gi;

/**
 * Collapse `<a href="">label</a>` to just `label`.
 *
 * Applied to the HTML body after substitution. The plain-text alternative is
 * derived from the swept HTML, so it inherits the fix for free.
 */
export function stripEmptyHrefAnchors(html: string): string {
  return html.replace(EMPTY_HREF_ANCHOR_RE, '$1');
}

/**
 * Resolve `{{#if var}}…{{/if}}` sections against the variable map. Runs
 * before token substitution so a dropped section's `{{vars}}` are never
 * looked at.
 */
function applyConditionalSections(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(SECTION_RE, (_match, name: string, body: string) => {
    const value = variables[name];
    return typeof value === 'string' && value.trim().length > 0 ? body : '';
  });
}

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
 * Substitute `{{var}}` occurrences in `template`, after resolving any
 * `{{#if var}}…{{/if}}` sections.
 *
 * Unknown variables are replaced with empty string (never the literal
 * token), so a template authored against an older variable set degrades
 * gracefully. That rule is also why `{{#if}}` exists: for a URL, "degrades
 * gracefully" would otherwise mean `href=""`.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string>,
  options: { escape: boolean },
): string {
  const withSections = applyConditionalSections(template, variables);
  return withSections.replace(TOKEN_RE, (_match, name: string) => {
    const value = variables[name] ?? '';
    return options.escape ? htmlEscape(value) : value;
  });
}

/**
 * Render an HTML body: substitution plus the empty-href sweep. Everything
 * that produces a mail body should go through here rather than calling
 * `renderTemplate` directly, so no send path can skip the sweep.
 */
export function renderHtmlBody(
  template: string,
  variables: Record<string, string>,
): string {
  return stripEmptyHrefAnchors(renderTemplate(template, variables, { escape: true }));
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
