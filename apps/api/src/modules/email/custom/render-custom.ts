/**
 * Rendering a custom template. The HTML body goes through the same escaping
 * renderer as the built-in templates. The subject is a header, so a line break
 * in a value could start a new header: values and the rendered subject have
 * every CR and LF replaced with a space.
 */

import { htmlToPlainText, renderHtmlBody, renderTemplate } from '../render.js';

const LINE_BREAK_RE = /[\r\n]+/g;
const MAX_SUBJECT = 998;

export interface RenderableTemplate {
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
}

export function renderSubject(subject: string, values: Record<string, string>): string {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) flat[name] = value.replace(LINE_BREAK_RE, ' ');
  return renderTemplate(subject, flat, { escape: false })
    .replace(LINE_BREAK_RE, ' ')
    .trim()
    .slice(0, MAX_SUBJECT);
}

const ANCHOR_RE = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi;

/**
 * Keep link addresses in the plain-text part: an anchor labelled "Track it"
 * becomes `Track it (https://...)`. Without it the text part loses every
 * link, which is the whole point of most transactional mail.
 */
export function keepLinkUrls(html: string): string {
  return html.replace(ANCHOR_RE, (whole, dq: string | undefined, sq: string | undefined, label: string) => {
    const href = (dq ?? sq ?? '').trim();
    if (href === '' || href.startsWith('#')) return whole;
    const text = label.replace(/<[^>]+>/g, '').trim();
    return text === '' || text === href ? href : `${label} (${href})`;
  });
}

export function renderCustom(
  template: RenderableTemplate,
  values: Record<string, string>,
): { subject: string; html: string; text: string } {
  const html = renderHtmlBody(template.bodyHtml, values);
  const text =
    template.bodyText !== null && template.bodyText.length > 0
      ? renderTemplate(template.bodyText, values, { escape: false })
      : htmlToPlainText(keepLinkUrls(html));
  return { subject: renderSubject(template.subject, values), html, text };
}
