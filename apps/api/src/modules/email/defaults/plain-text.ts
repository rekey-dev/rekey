/**
 * The text/plain alternative of a default email, written from the same blocks
 * as the HTML rather than scraped from it, so it reads like an email and not
 * like a page with its tags removed.
 */

import { ATTRIBUTION_TEXT, ATTRIBUTION_URL, FOOTER_REASON_PREFIX, type EmailBlock, type EmailSpec } from './blocks.js';
import type { EmailBrand } from './brand.js';

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/**
 * Block copy is inline HTML (`<strong>`, entities). Plain text wants neither.
 *
 * @example
 * inlineText('Hi <strong>Tom &amp; Jerry</strong>'); // 'Hi Tom & Jerry'
 */
export function inlineText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e]!)
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function blockText(block: EmailBlock): string | null {
  switch (block.kind) {
    case 'heading':
      return inlineText(block.text);
    case 'paragraph':
    case 'note':
    case 'alert':
      return inlineText(block.html);
    case 'button':
      return `${block.label}:\n{{${block.hrefVar}}}`;
    case 'details':
      return block.rows.map((r) => `${inlineText(r.label)}: ${inlineText(r.html)}`).join('\n');
    case 'divider':
      return null;
  }
}

function supportText(brand: EmailBrand): string | null {
  if (brand.supportEmail !== null) return `Need help? Contact ${brand.supportEmail}.`;
  if (brand.supportUrl !== null) return `Need help? Visit ${brand.supportUrl}`;
  return null;
}

/**
 * @example
 * renderSpecText(spec, brand); // 'Acme\n\nReset your password\n\n...'
 */
export function renderSpecText(spec: EmailSpec, brand: EmailBrand): string {
  // The separator sits inside a button's `{{#if}}`, so a mail whose link did
  // not resolve has no gap where the button would have been.
  const body = spec.blocks
    .map((block) => {
      const t = blockText(block);
      if (t === null) return '';
      return block.kind === 'button' ? `{{#if ${block.hrefVar}}}\n\n${t}{{/if}}` : `\n\n${t}`;
    })
    .join('');
  const footer = [
    brand.name,
    `${FOOTER_REASON_PREFIX} ${inlineText(spec.reason)}`,
    supportText(brand),
    brand.attribution ? `\n${ATTRIBUTION_TEXT}: ${ATTRIBUTION_URL}` : null,
  ].filter((l): l is string => l !== null);
  return `${brand.name}${body}\n\n--\n${footer.join('\n')}\n`;
}
