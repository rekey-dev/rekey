/**
 * The building blocks every default template is written in.
 *
 * A default is a list of blocks rather than a finished HTML string so that the
 * same content can produce the inbox-safe HTML we send, its plain-text
 * alternative, and the Unlayer design the panel's editor opens with (see
 * `plain-text.ts` and `unlayer-design.ts`). One source means the three can
 * never disagree about the default.
 */

import type { EmailBrand } from './brand.js';
import { CONTENT_WIDTH, FONT_STACK, MONO_STACK, themeFor, type Theme } from './theme.js';

export type EmailBlock =
  | { kind: 'heading'; text: string }
  /** Body copy. Inline markup (`<strong>`) and `{{var}}` tokens are allowed. */
  | { kind: 'paragraph'; html: string }
  /** Small grey print: expiry lines, "you can ignore this" lines. */
  | { kind: 'note'; html: string }
  /** A boxed line that must not be skimmed past: "if this wasn't you". */
  | { kind: 'alert'; html: string }
  /** Call-to-action button whose href is the named variable, with the raw link under it. */
  | { kind: 'button'; hrefVar: string; label: string }
  /** Label and value pairs, such as a payment's amount and plan. */
  | { kind: 'details'; rows: ReadonlyArray<{ label: string; html: string; mono?: boolean }> }
  | { kind: 'divider' };

/** Everything a default email is made of, before it is rendered. */
export interface EmailSpec {
  subject: string;
  /** The line inbox lists show after the subject. */
  preheader: string;
  blocks: readonly EmailBlock[];
  /** Completes "You're receiving this email because ...". */
  reason: string;
}

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * @example
 * escapeHtml('Tom & Jerry'); // 'Tom &amp; Jerry'
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]!);
}

/** Keeps inbox previews from pulling body text in after a short preheader. */
const PREHEADER_PAD = '&#847;&zwnj;&nbsp;'.repeat(60);

export const FOOTER_REASON_PREFIX = "You're receiving this email because";

export const ATTRIBUTION_TEXT = 'Secured by Rekey';
export const ATTRIBUTION_URL = 'https://rekey.dev';

export const BUTTON_FALLBACK_TEXT = 'Button not working? Paste this link into your browser:';

function text(style: string): string {
  return `font-family:${FONT_STACK};${style}`;
}

function button(t: Theme, hrefVar: string, label: string): string {
  const href = `{{${hrefVar}}}`;
  const vmlWidth = Math.max(160, label.length * 9 + 56);
  return `{{#if ${hrefVar}}}<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
<tr><td align="left">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:46px;v-text-anchor:middle;width:${vmlWidth}px;" arcsize="18%" stroke="f" fillcolor="${t.accent}"><w:anchorlock/><center style="color:${t.accentText};font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${label}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a class="rk-btn" href="${href}" target="_blank" style="display:inline-block;background-color:${t.accent};color:${t.accentText};${text('font-size:15px;font-weight:600;line-height:20px;text-decoration:none;padding:13px 28px;border-radius:8px;')}">${label}</a><!--<![endif]-->
</td></tr>
</table>
<p class="rk-muted" style="margin:0 0 24px;${text(`font-size:13px;line-height:20px;color:${t.light.muted};`)}">${BUTTON_FALLBACK_TEXT}<br><a class="rk-link" href="${href}" style="color:${t.link};text-decoration:underline;word-break:break-all;">${href}</a></p>{{/if}}`;
}

function details(t: Theme, rows: ReadonlyArray<{ label: string; html: string; mono?: boolean }>): string {
  const body = rows
    .map((r, i) => {
      const rule = i === 0 ? '' : `border-top:1px solid ${t.light.border};`;
      const valueFont = r.mono ? `font-family:${MONO_STACK};font-size:13px;` : `font-family:${FONT_STACK};font-size:14px;`;
      return `<tr><td class="rk-muted rk-border" style="padding:12px 16px;${rule}${text(`font-size:13px;line-height:20px;color:${t.light.muted};`)}width:40%;vertical-align:top;">${r.label}</td><td class="rk-text rk-border" style="padding:12px 16px;${rule}${valueFont}line-height:20px;color:${t.light.text};text-align:right;vertical-align:top;${r.mono ? 'word-break:break-all;' : ''}">${r.html}</td></tr>`;
    })
    .join('\n');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="rk-panel rk-border" style="margin:8px 0 24px;background-color:${t.light.panel};border:1px solid ${t.light.border};border-radius:8px;border-collapse:separate;">
${body}
</table>`;
}

/**
 * One block as inbox-safe HTML.
 *
 * @example
 * blockHtml(themeFor(SYSTEM_BRAND), { kind: 'divider' });
 */
export function blockHtml(t: Theme, block: EmailBlock): string {
  switch (block.kind) {
    case 'heading':
      return `<h1 class="rk-text" style="margin:0 0 16px;${text(`font-size:24px;line-height:32px;font-weight:700;letter-spacing:-0.3px;color:${t.light.text};`)}">${block.text}</h1>`;
    case 'paragraph':
      return `<p class="rk-body" style="margin:0 0 16px;${text(`font-size:16px;line-height:26px;color:${t.light.body};`)}">${block.html}</p>`;
    case 'note':
      return `<p class="rk-muted" style="margin:0 0 12px;${text(`font-size:14px;line-height:22px;color:${t.light.muted};`)}">${block.html}</p>`;
    case 'alert':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 16px;"><tr><td class="rk-panel rk-border rk-body" style="padding:14px 16px;background-color:${t.light.panel};border:1px solid ${t.light.border};border-left:3px solid ${t.accent};border-radius:6px;${text(`font-size:14px;line-height:22px;color:${t.light.body};`)}">${block.html}</td></tr></table>`;
    case 'button':
      return button(t, block.hrefVar, block.label);
    case 'details':
      return details(t, block.rows);
    case 'divider':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 20px;"><tr><td class="rk-border" style="border-top:1px solid ${t.light.border};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`;
  }
}

function darkModeCss(t: Theme): string {
  const d = t.dark;
  const rules = `.rk-canvas{background-color:${d.canvas}!important}
.rk-card{background-color:${d.card}!important;border-color:${d.border}!important}
.rk-panel{background-color:${d.panel}!important}
.rk-border{border-color:${d.border}!important}
.rk-text{color:${d.text}!important}
.rk-body{color:${d.body}!important}
.rk-muted{color:${d.muted}!important}
.rk-link{color:${t.darkLink}!important}
.rk-btn{background-color:${t.darkButton}!important;color:${t.darkButtonText}!important}`;
  const outlook = rules.replace(/^\./gm, '[data-ogsc] .');
  return `@media (prefers-color-scheme:dark){
${rules}
}
${outlook}`;
}

/**
 * The logo, or the brand's name when it has none.
 *
 * @example
 * header(themeFor(SYSTEM_BRAND), SYSTEM_BRAND); // '<span ...>Rekey</span>'
 */
export function header(t: Theme, brand: EmailBrand): string {
  const name = escapeHtml(brand.name);
  if (brand.logoUrl !== null) {
    return `<img src="${escapeHtml(brand.logoUrl)}" alt="${name}" height="32" style="display:block;height:32px;width:auto;max-width:200px;border:0;outline:none;text-decoration:none;${text(`font-size:18px;font-weight:700;color:${t.light.text};`)}">`;
  }
  return `<span class="rk-text" style="${text(`font-size:18px;line-height:24px;font-weight:700;letter-spacing:-0.2px;color:${t.light.text};`)}">${name}</span>`;
}

/**
 * The footer's support line, or the empty string when the brand has no
 * support contact.
 */
function supportLine(t: Theme, brand: EmailBrand): string {
  const link = (href: string, label: string): string =>
    `<a class="rk-muted" href="${escapeHtml(href)}" style="color:${t.light.muted};text-decoration:underline;">${escapeHtml(label)}</a>`;
  if (brand.supportEmail !== null) {
    return `Need help? Contact ${link(`mailto:${brand.supportEmail}`, brand.supportEmail)}.`;
  }
  if (brand.supportUrl !== null) {
    return `Need help? ${link(brand.supportUrl, 'Visit our help page')}.`;
  }
  return '';
}

/**
 * The brand's name, why the reader got this email, and the support contact.
 *
 * @example
 * footer(themeFor(SYSTEM_BRAND), SYSTEM_BRAND, 'you signed up.');
 */
export function footer(t: Theme, brand: EmailBrand, reason: string): string {
  const line = (html: string, extra = ''): string =>
    `<p class="rk-muted" style="margin:0 0 6px;${text(`font-size:13px;line-height:20px;color:${t.light.muted};`)}${extra}">${html}</p>`;
  const support = supportLine(t, brand);
  return [
    line(`<strong class="rk-text" style="color:${t.light.text};font-weight:600;">${escapeHtml(brand.name)}</strong>`),
    line(`${FOOTER_REASON_PREFIX} ${reason}`),
    support === '' ? '' : line(support),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The "Secured by Rekey" line under the footer, or the empty string. Kept out
 * of `footer` because the editor design is built from that, and the line must
 * never be saved into an operator's own template.
 */
function attribution(t: Theme, brand: EmailBrand): string {
  if (!brand.attribution) return '';
  return `\n<p class="rk-muted" style="margin:14px 0 0;${text(`font-size:12px;line-height:18px;color:${t.light.muted};`)}"><a class="rk-muted" href="${ATTRIBUTION_URL}" target="_blank" style="color:${t.light.muted};text-decoration:none;">${ATTRIBUTION_TEXT}</a></p>`;
}

/**
 * Render a default template as the inbox-safe HTML body: table layout, inline
 * styles, a 600px column, a system font stack, a bulletproof button with a
 * VML fallback for Outlook, and dark-mode overrides for the clients that
 * honour them.
 *
 * @example
 * renderSpecHtml({ subject: 'Hi', preheader: 'Hi', reason: 'you signed up.', blocks: [] }, SYSTEM_BRAND);
 */
export function renderSpecHtml(spec: EmailSpec, brand: EmailBrand): string {
  const t = themeFor(brand);
  const l = t.light;
  const blocks = spec.blocks.map((b) => blockHtml(t, b)).join('\n');
  return `<!doctype html>
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(spec.subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0;padding:0;width:100%;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}
img{-ms-interpolation-mode:bicubic}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
@media (max-width:620px){.rk-outer{padding:24px 12px!important}.rk-pad{padding-left:24px!important;padding-right:24px!important}}
${darkModeCss(t)}
</style>
</head>
<body class="rk-canvas" style="margin:0;padding:0;width:100%;background-color:${l.canvas};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(spec.preheader)}${PREHEADER_PAD}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="rk-canvas" style="background-color:${l.canvas};">
<tr><td align="center" class="rk-outer" style="padding:40px 16px;">
<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${CONTENT_WIDTH}" align="center"><tr><td><![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:${CONTENT_WIDTH}px;margin:0 auto;">
<tr><td class="rk-pad" style="padding:0 40px 24px;" align="left">${header(t, brand)}</td></tr>
<tr><td class="rk-card" style="background-color:${l.card};border:1px solid ${l.border};border-radius:12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td style="height:4px;background-color:${t.accent};border-radius:11px 11px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td class="rk-pad" style="padding:36px 40px 20px;" align="left">
${blocks}
</td></tr>
</table>
</td></tr>
<tr><td class="rk-pad" style="padding:24px 40px 0;" align="left">
${footer(t, brand, spec.reason)}${attribution(t, brand)}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}
