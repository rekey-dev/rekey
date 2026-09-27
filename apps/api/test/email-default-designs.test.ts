/**
 * The default templates open in the panel's Unlayer editor as a design, go out
 * to inboxes as HTML, and carry a plain-text alternative. All three come from
 * the same blocks and the sending Application's brand, and these tests hold
 * them together and hold the brand to values that are safe to inline.
 */

import { describe, expect, it } from 'vitest';
import {
  brandFromApplication,
  defaultTemplate,
  SYSTEM_BRAND,
  type EmailBrand,
  type UnlayerDesign,
} from '../src/modules/email/defaults/index.js';
import { NEUTRAL_ACCENT } from '../src/modules/email/defaults/brand.js';
import { inlineText } from '../src/modules/email/defaults/plain-text.js';
import { themeFor } from '../src/modules/email/defaults/theme.js';
import { EMAIL_EVENTS, type EmailEventKey } from '../src/modules/email/events.js';
import { renderHtmlBody, renderTemplate } from '../src/modules/email/render.js';

/** The panel's own check (apps/panel/src/lib/email-editor-design.ts) before it calls loadDesign. */
function isLoadableDesign(design: unknown): boolean {
  const rows = (design as { body?: { rows?: unknown } } | null)?.body?.rows;
  return Array.isArray(rows) && rows.length > 0;
}

const EVENT_KEYS = Object.keys(EMAIL_EVENTS) as EmailEventKey[];

const ACME: EmailBrand = brandFromApplication({
  name: 'acme-prod',
  portalBranding: {
    displayName: 'Acme',
    logoUrl: 'https://cdn.example.com/acme.png',
    primaryColor: '#4f46e5',
    supportEmail: 'help@acme.example',
  },
});
const BRANDS: Array<[string, EmailBrand]> = [
  ['branded', ACME],
  ['unbranded', brandFromApplication({ name: 'Plain', portalBranding: {} })],
  ['system', SYSTEM_BRAND],
];

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function designContents(design: UnlayerDesign) {
  return design.body.rows.flatMap((r) => r.columns.flatMap((c) => c.contents));
}

function designText(design: UnlayerDesign): string {
  return normalise(
    designContents(design)
      .map((c) => inlineText(String(c.type === 'html' ? c.values.html : c.values.text)))
      .join(' '),
  );
}

function designTokens(design: UnlayerDesign): string[] {
  return [...JSON.stringify(design).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
}

function render(key: EmailEventKey, brand: EmailBrand, vars = EMAIL_EVENTS[key].sampleValues) {
  const t = defaultTemplate(key, brand);
  return {
    subject: renderTemplate(t.subject, vars, { escape: false }),
    html: renderHtmlBody(t.html, vars),
    text: renderTemplate(t.text, vars, { escape: false }),
  };
}

describe('default template designs', () => {
  it.each(EVENT_KEYS)('%s: the design is a loadable Unlayer document with unique ids', (key) => {
    const { design } = defaultTemplate(key, ACME);
    const parsed = JSON.parse(JSON.stringify(design)) as UnlayerDesign;
    expect(isLoadableDesign(parsed)).toBe(true);
    expect(parsed.body.rows).toHaveLength(3);
    expect(parsed.body.rows[1]?.columns[0]?.contents[0]?.type).toBe('heading');
    const ids = designContents(parsed).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [kind, n] of Object.entries(parsed.counters)) {
      expect(ids.filter((id) => id.startsWith(`${kind}_`)).length).toBeLessThanOrEqual(n);
    }
  });

  it.each(EVENT_KEYS)('%s: every block reads the same in the design and in the HTML', (key) => {
    const t = defaultTemplate(key, ACME);
    const design = designText(t.design);
    const html = normalise(inlineText(t.html.replace(/<style[\s\S]*?<\/style>|<title>[\s\S]*?<\/title>/g, '')));
    for (const block of t.blocks) {
      const texts =
        block.kind === 'heading' ? [block.text]
        : block.kind === 'button' ? [block.label]
        : block.kind === 'details' ? block.rows.flatMap((r) => [r.label, r.html])
        : block.kind === 'divider' ? []
        : [block.html];
      for (const raw of texts) {
        const text = normalise(inlineText(raw));
        expect(design).toContain(text);
        expect(html).toContain(text);
      }
    }
    expect(t.design.body.values.preheaderText).toBeTruthy();
  });

  it.each(EVENT_KEYS)('%s: the design only uses variables the event registers', (key) => {
    const registered = new Set(EMAIL_EVENTS[key].variables);
    for (const token of designTokens(defaultTemplate(key, ACME).design)) {
      expect(registered).toContain(token);
    }
  });

  it.each(EVENT_KEYS)('%s: a button in the design links to its URL variable', (key) => {
    const { design, blocks } = defaultTemplate(key, ACME);
    const buttons = designContents(design).filter((x) => x.type === 'button');
    const expected = blocks.flatMap((b) => (b.kind === 'button' ? [`{{${b.hrefVar}}}`] : []));
    expect(buttons.map((b) => (b.values.href as { values: { href: string } }).values.href)).toEqual(expected);
  });
});

describe('default template HTML', () => {
  it.each(EVENT_KEYS.flatMap((k) => BRANDS.map(([n, b]) => [k, n, b] as const)))(
    '%s (%s): renders an email-client-safe document',
    (key, _name, brand) => {
      const { html, subject } = render(key, brand);
      expect(subject.length).toBeGreaterThan(0);
      expect(html).toMatch(/^<!doctype html>\n<html lang="en" dir="ltr"/);
      expect(html).toContain('<meta name="color-scheme" content="light dark">');
      expect(html).toContain('@media (prefers-color-scheme:dark)');
      expect(html).toContain('max-width:600px');
      expect(html).not.toMatch(/<table(?![^>]*role="presentation")/);
      expect(html).not.toMatch(/https?:\/\/fonts\./);
      expect(html).not.toMatch(/\{\{/);
      expect(html).not.toContain('Sent via Rekey');
    },
  );

  it.each(EVENT_KEYS)('%s: carries a preheader and, with a button, an Outlook VML fallback and the raw link', (key) => {
    const t = defaultTemplate(key, ACME);
    expect(t.html).toMatch(/<div style="display:none;[^"]*">[^<&]{10,}/);
    for (const block of t.blocks) {
      if (block.kind !== 'button') continue;
      const { html } = render(key, ACME);
      const url = EMAIL_EVENTS[key].sampleValues[block.hrefVar]!.replace(/&/g, '&amp;');
      expect(html).toContain(`<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}"`);
      expect(html).toContain(`>${url}</a>`);
    }
  });

  it('password_changed and mfa_enabled tell someone who did not do it to reset their password', () => {
    for (const key of ['password_changed', 'mfa_enabled'] as const) {
      expect(render(key, ACME).text).toContain("Didn't do this? Someone else may have access to your account. Reset your password right away");
    }
  });

  it.each(['password_reset', 'email_verification', 'magic_link_signin', 'workspace_invitation'] as const)(
    '%s: states when the link expires and that it can be ignored',
    (key) => {
      const { text } = render(key, ACME);
      expect(text).toContain(`expires at ${EMAIL_EVENTS[key].sampleValues.expiresAt!}`);
      expect(text).not.toContain(EMAIL_EVENTS[key].sampleValues.expiresAtIso!);
      expect(text).toMatch(/you can safely ignore this email/);
    },
  );

  it('HTML-escapes every variable value', () => {
    for (const key of EVENT_KEYS) {
      const hostile = Object.fromEntries(
        EMAIL_EVENTS[key].variables.map((v) => [v, '"><script>alert(1)</script>']),
      );
      const { html } = render(key, ACME, hostile);
      expect(html, key).not.toContain('<script>');
      expect(html, key).toContain('&lt;script&gt;');
    }
  });

  it('no default uses an em dash', () => {
    for (const key of EVENT_KEYS) {
      for (const [, brand] of BRANDS) {
        const t = defaultTemplate(key, brand);
        expect(`${t.subject}${t.html}${t.text}${JSON.stringify(t.design)}`).not.toContain('—');
      }
    }
  });
});

describe('default template plain text', () => {
  it.each(EVENT_KEYS)('%s: is written text with the brand, the link and the reason, and no markup', (key) => {
    const { text } = render(key, ACME);
    const t = defaultTemplate(key, ACME);
    expect(t.text.length).toBeGreaterThan(100);
    expect(text).not.toMatch(/<\/?[a-z]/i);
    expect(text).not.toMatch(/&(amp|lt|gt|quot|#39);/);
    expect(text.startsWith('Acme\n\n')).toBe(true);
    expect(text).toContain("\n--\nAcme\nYou're receiving this email because");
    for (const block of t.blocks) {
      if (block.kind === 'button') expect(text).toContain(EMAIL_EVENTS[key].sampleValues[block.hrefVar]!);
    }
  });

  it('drops the button line, and the gap before it, when the link did not resolve', () => {
    const text = renderTemplate(defaultTemplate('welcome', ACME).text, { userEmail: 'a@example.com', appUrl: '' }, { escape: false });
    expect(text).not.toContain('Get started');
    expect(text).not.toMatch(/\n{3,}/);
  });
});

describe('brand values from operator input', () => {
  it('uses the display name, logo, colour and support contact', () => {
    expect(ACME).toEqual({
      name: 'Acme',
      logoUrl: 'https://cdn.example.com/acme.png',
      accent: '#4f46e5',
      supportEmail: 'help@acme.example',
      supportUrl: null,
      attribution: false,
    });
  });

  it('falls back to the Application name and a neutral colour, with no logo', () => {
    const brand = brandFromApplication({ name: 'Plain', portalBranding: { displayName: '  ', primaryColor: '' } });
    expect(brand).toEqual({
      name: 'Plain',
      logoUrl: null,
      accent: NEUTRAL_ACCENT,
      supportEmail: null,
      supportUrl: null,
      attribution: false,
    });
    const { html } = render('password_reset', brand);
    expect(html).not.toContain('<img');
    expect(html).toContain('>Plain</span>');
  });

  it.each([
    'red;background:url(https://evil.example/x)',
    '#fff;}body{display:none',
    'expression(alert(1))',
    'rgb(1,2,3)',
    '#12345',
    '#11223344',
    'url(javascript:alert(1))',
  ])('refuses the colour %j and uses the neutral accent', (primaryColor) => {
    const brand = brandFromApplication({ name: 'X', portalBranding: { primaryColor } });
    expect(brand.accent).toBe(NEUTRAL_ACCENT);
    expect(render('welcome', brand).html).not.toContain(primaryColor);
  });

  it('expands a short hex colour', () => {
    expect(brandFromApplication({ name: 'X', portalBranding: { primaryColor: '#F0A' } }).accent).toBe('#ff00aa');
  });

  it.each([
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
    'http://cdn.example.com/logo.png',
    '//cdn.example.com/logo.png',
    'not a url',
  ])('drops the logo %j', (logoUrl) => {
    const brand = brandFromApplication({ name: 'X', portalBranding: { logoUrl } });
    expect(brand.logoUrl).toBeNull();
    expect(render('welcome', brand).html).not.toContain('<img');
  });

  it('keeps a logo URL from breaking out of its attribute or forming a token', () => {
    const brand = brandFromApplication({
      name: 'X',
      portalBranding: { logoUrl: 'https://cdn.example.com/a.png?x="onerror="alert(1)&t={{resetUrl}}' },
    });
    const { html } = render('password_reset', brand, { userEmail: 'a@example.com', resetUrl: 'https://secret.example/r', expiresAtIso: 'x' });
    const img = /<img src="([^"]*)"/.exec(html)?.[1];
    expect(img).toBeDefined();
    expect(img).not.toContain('"');
    expect(img).not.toContain('secret.example');
    expect(html).not.toContain('onerror="alert');
  });

  it('escapes a hostile name and never lets it act as a {{token}}', () => {
    const brand = brandFromApplication({
      name: 'X',
      portalBranding: { displayName: '<img src=x onerror=alert(1)>{{resetUrl}}{{#if resetUrl}}' },
    });
    const vars = { userEmail: 'a@example.com', resetUrl: 'https://secret.example/r', expiresAtIso: 'x' };
    const { html, text, subject } = render('password_reset', brand, vars);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(subject).not.toContain('secret.example');
    expect(html.match(/secret\.example/g)?.length).toBe(4);
    expect(text).toContain('Reset password:\nhttps://secret.example/r');
  });

  it.each(['help@acme.example?bcc=victim@example.com', '"><script>@x.example', 'no-at-sign', 'a{{b}}@x.example'])(
    'drops the support address %j',
    (supportEmail) => {
      const brand = brandFromApplication({ name: 'X', portalBranding: { supportEmail } });
      expect(brand.supportEmail).toBeNull();
      expect(render('welcome', brand).html).not.toContain('mailto:');
    },
  );

  it('keeps the button label and links readable on a very light or very dark accent', () => {
    const light = themeFor(brandFromApplication({ name: 'X', portalBranding: { primaryColor: '#fde047' } }));
    expect(light.accentText).toBe('#18181b');
    expect(light.link).toBe('#18181b');
    const dark = themeFor(brandFromApplication({ name: 'X', portalBranding: { primaryColor: '#111111' } }));
    expect(dark.accentText).toBe('#ffffff');
    expect(dark.darkButton).not.toBe('#111111');
  });
});
