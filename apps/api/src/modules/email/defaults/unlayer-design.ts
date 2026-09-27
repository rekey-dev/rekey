/**
 * Unlayer design documents for the default templates.
 *
 * The panel's drag-and-drop editor can only open a design document, not HTML.
 * Without one a template that was never customised opened on an empty canvas,
 * so an operator who wanted to change one line of the default had to rebuild
 * the whole mail. This turns the same blocks that render the default HTML into
 * the editor's block tree: the logo or name above a white card holding the
 * blocks, and the footer below it.
 *
 * Only the values that differ from Unlayer's own defaults are set; the editor
 * fills in the rest when it loads the document. Blocks Unlayer has no native
 * shape for (the security callout, the details table, the header logo) travel
 * as html blocks carrying the same markup the default HTML uses.
 */

import {
  BUTTON_FALLBACK_TEXT,
  blockHtml,
  footer,
  header,
  type EmailBlock,
  type EmailSpec,
} from './blocks.js';
import type { EmailBrand } from './brand.js';
import { CONTENT_WIDTH, FONT_STACK, themeFor, type Theme } from './theme.js';

export interface UnlayerContent {
  id: string;
  type: 'heading' | 'text' | 'button' | 'html' | 'divider';
  values: Record<string, unknown>;
}

export interface UnlayerDesign {
  counters: Record<string, number>;
  body: {
    id: string;
    rows: Array<{
      id: string;
      cells: number[];
      columns: Array<{ id: string; contents: UnlayerContent[]; values: Record<string, unknown> }>;
      values: Record<string, unknown>;
    }>;
    headers: never[];
    footers: never[];
    values: Record<string, unknown>;
  };
  schemaVersion: number;
}

// The schema version react-email-editor 1.8 writes. Unlayer migrates older
// documents forward on load, so an older number is safe and a newer one is not.
const SCHEMA_VERSION = 16;

class IdSource {
  readonly counters: Record<string, number> = {};

  next(kind: string): { id: string; meta: { htmlID: string; htmlClassNames: string } } {
    const n = (this.counters[kind] ?? 0) + 1;
    this.counters[kind] = n;
    return { id: `${kind}_${n}`, meta: { htmlID: `${kind}_${n}`, htmlClassNames: kind } };
  }
}

function textContent(ids: IdSource, html: string, values: Record<string, unknown>): UnlayerContent {
  const { id, meta } = ids.next('u_content_text');
  return { id, type: 'text', values: { textAlign: 'left', text: html, ...values, _meta: meta } };
}

function htmlContent(ids: IdSource, html: string): UnlayerContent {
  const { id, meta } = ids.next('u_content_html');
  return { id, type: 'html', values: { html, containerPadding: '0px', _meta: meta } };
}

function contents(ids: IdSource, t: Theme, block: EmailBlock): UnlayerContent[] {
  const body = { fontSize: '16px', lineHeight: '160%', color: t.light.body };
  switch (block.kind) {
    case 'heading': {
      const { id, meta } = ids.next('u_content_heading');
      return [
        {
          id,
          type: 'heading',
          values: {
            headingType: 'h1',
            text: block.text,
            fontSize: '24px',
            fontWeight: 700,
            lineHeight: '133%',
            letterSpacing: '-0.3px',
            textAlign: 'left',
            color: t.light.text,
            containerPadding: '0px 0px 16px',
            _meta: meta,
          },
        },
      ];
    }
    case 'paragraph':
      return [textContent(ids, `<p>${block.html}</p>`, { ...body, containerPadding: '0px 0px 16px' })];
    case 'note':
      return [
        textContent(ids, `<p>${block.html}</p>`, {
          fontSize: '14px',
          lineHeight: '157%',
          color: t.light.muted,
          containerPadding: '0px 0px 12px',
        }),
      ];
    case 'alert':
    case 'details':
      return [htmlContent(ids, blockHtml(t, block))];
    case 'button': {
      const { id, meta } = ids.next('u_content_button');
      const href = `{{${block.hrefVar}}}`;
      return [
        {
          id,
          type: 'button',
          values: {
            href: { name: 'web', values: { href, target: '_blank' } },
            buttonColors: {
              color: t.accentText,
              backgroundColor: t.accent,
              hoverColor: t.accentText,
              hoverBackgroundColor: t.accent,
            },
            size: { autoWidth: true, width: '100%' },
            fontSize: '15px',
            fontWeight: 600,
            lineHeight: '133%',
            textAlign: 'left',
            padding: '13px 28px',
            borderRadius: '8px',
            text: block.label,
            containerPadding: '8px 0px 24px',
            _meta: meta,
          },
        },
        textContent(
          ids,
          `<p>{{#if ${block.hrefVar}}}${BUTTON_FALLBACK_TEXT}<br><a href="${href}" style="color:${t.link};word-break:break-all;">${href}</a>{{/if}}</p>`,
          { fontSize: '13px', lineHeight: '154%', color: t.light.muted, containerPadding: '0px 0px 24px' },
        ),
      ];
    }
    case 'divider': {
      const { id, meta } = ids.next('u_content_divider');
      return [
        {
          id,
          type: 'divider',
          values: {
            width: '100%',
            border: { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: t.light.border },
            textAlign: 'center',
            containerPadding: '8px 0px 20px',
            _meta: meta,
          },
        },
      ];
    }
  }
}

function row(ids: IdSource, items: UnlayerContent[], columnValues: Record<string, unknown>) {
  const r = ids.next('u_row');
  const c = ids.next('u_column');
  return {
    id: r.id,
    cells: [1],
    columns: [{ id: c.id, contents: items, values: { ...columnValues, _meta: c.meta } }],
    values: { padding: '0px', backgroundColor: '', columnsBackgroundColor: '', _meta: r.meta },
  };
}

function side(width: string, color: string, prefix: 'Top' | 'Left' | 'Right' | 'Bottom') {
  return {
    [`border${prefix}Width`]: width,
    [`border${prefix}Style`]: 'solid',
    [`border${prefix}Color`]: color,
  };
}

/**
 * Build the Unlayer design for a default template.
 *
 * @example
 * const design = specToUnlayerDesign(spec, brandFromApplication(app));
 * design.body.rows[1]?.columns[0]?.contents[0]?.type; // 'heading'
 */
export function specToUnlayerDesign(spec: EmailSpec, brand: EmailBrand): UnlayerDesign {
  const t = themeFor(brand);
  const ids = new IdSource();
  const top = brand.logoUrl === null
    ? textContent(ids, `<p>${header(t, brand)}</p>`, { containerPadding: '0px 40px 24px' })
    : htmlContent(ids, `<div style="padding:0 40px 24px;">${header(t, brand)}</div>`);
  const headerRow = row(ids, [top], { backgroundColor: '', padding: '0px' });
  const card = row(
    ids,
    spec.blocks.flatMap((b) => contents(ids, t, b)),
    {
      backgroundColor: t.light.card,
      padding: '36px 40px 20px',
      borderRadius: '12px',
      border: {
        ...side('4px', t.accent, 'Top'),
        ...side('1px', t.light.border, 'Left'),
        ...side('1px', t.light.border, 'Right'),
        ...side('1px', t.light.border, 'Bottom'),
      },
    },
  );
  const footerRow = row(
    ids,
    [textContent(ids, footer(t, brand, spec.reason), { containerPadding: '24px 40px 0px' })],
    { backgroundColor: '', padding: '0px' },
  );
  return {
    counters: { ...ids.counters },
    body: {
      id: 'u_body',
      rows: [headerRow, card, footerRow],
      headers: [],
      footers: [],
      values: {
        backgroundColor: t.light.canvas,
        contentWidth: `${CONTENT_WIDTH}px`,
        contentAlign: 'center',
        padding: '40px 16px',
        fontFamily: { label: 'System', value: FONT_STACK },
        textColor: t.light.body,
        preheaderText: spec.preheader,
        linkStyle: {
          body: true,
          linkColor: t.link,
          linkHoverColor: t.link,
          linkUnderline: true,
          linkHoverUnderline: true,
        },
        _meta: { htmlID: 'u_body', htmlClassNames: 'u_body' },
      },
    },
    schemaVersion: SCHEMA_VERSION,
  };
}
