/**
 * The portal's XSS boundary.
 *
 * `safeCssColor` and `safeHttpUrl` are the only things standing between an
 * operator-supplied string and, respectively, an inline `style` attribute and
 * an `<img src>` on a page shown to that operator's paying customers
 * (`[slug]/layout.tsx`). React escapes the attribute value, so there is no
 * attribute breakout — but nothing stops extra CSS declarations riding along in
 * a colour, or a `javascript:` / `data:` URL in a logo.
 *
 * Everything here is a pure function, so this file needs no fixtures, no
 * network and no database.
 */

import { describe, expect, it } from 'vitest';
import { safeCssColor, safeHttpUrl, supportLink } from '@/lib/config';

describe('safeCssColor', () => {
  it('accepts hex colours of every legal length', () => {
    expect(safeCssColor('#fff')).toBe('#fff');
    expect(safeCssColor('#0d9488')).toBe('#0d9488');
    expect(safeCssColor('#0d9488ff')).toBe('#0d9488ff');
  });

  it('accepts functional colour notations', () => {
    expect(safeCssColor('rgb(13, 148, 136)')).toBe('rgb(13, 148, 136)');
    expect(safeCssColor('rgba(13,148,136,0.5)')).toBe('rgba(13,148,136,0.5)');
    expect(safeCssColor('hsl(174 80% 32%)')).toBe('hsl(174 80% 32%)');
  });

  it('accepts bare named colours', () => {
    expect(safeCssColor('rebeccapurple')).toBe('rebeccapurple');
  });

  it('trims surrounding whitespace rather than rejecting it', () => {
    expect(safeCssColor('  #abc  ')).toBe('#abc');
  });

  // The reason this function exists: a value the browser would happily parse
  // as MORE than one declaration.
  it('rejects a colour that smuggles extra declarations', () => {
    expect(safeCssColor('red;display:none')).toBeUndefined();
    expect(safeCssColor('red; background: url(https://evil.example/x)')).toBeUndefined();
  });

  it('rejects url() and var() payloads', () => {
    expect(safeCssColor('url(https://evil.example/track.png)')).toBeUndefined();
    expect(safeCssColor('var(--anything)')).toBeUndefined();
  });

  it('rejects a closing brace that would escape the rule', () => {
    expect(safeCssColor('#fff}html{display:none')).toBeUndefined();
  });

  it('returns undefined for empty and missing input so the caller can skip it', () => {
    expect(safeCssColor(undefined)).toBeUndefined();
    expect(safeCssColor('')).toBeUndefined();
    // Whitespace-only trims to empty, which is not a colour.
    expect(safeCssColor('   ')).toBeUndefined();
  });
});

describe('safeHttpUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(safeHttpUrl('https://cdn.example.com/logo.png')).toBe('https://cdn.example.com/logo.png');
    expect(safeHttpUrl('http://example.com/a.png')).toBe('http://example.com/a.png');
  });

  it('rejects javascript: and data: URLs', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeHttpUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBeUndefined();
  });

  it('rejects other schemes an operator could point a customer at', () => {
    expect(safeHttpUrl('file:///etc/passwd')).toBeUndefined();
    expect(safeHttpUrl('ftp://example.com/logo.png')).toBeUndefined();
  });

  it('rejects relative and unparseable values', () => {
    expect(safeHttpUrl('/logo.png')).toBeUndefined();
    expect(safeHttpUrl('not a url')).toBeUndefined();
    expect(safeHttpUrl(undefined)).toBeUndefined();
    expect(safeHttpUrl('')).toBeUndefined();
  });

  // Leading whitespace is a classic scheme-filter bypass; this one trims first.
  it('trims before parsing', () => {
    expect(safeHttpUrl('  https://example.com/a.png ')).toBe('https://example.com/a.png');
    expect(safeHttpUrl('  javascript:alert(1)')).toBeUndefined();
  });
});

describe('supportLink', () => {
  it('prefers a valid supportUrl over supportEmail', () => {
    expect(supportLink({ supportUrl: 'https://help.example.com', supportEmail: 'a@b.com' }))
      .toBe('https://help.example.com/');
  });

  it('falls back to mailto: when the URL is unusable', () => {
    expect(supportLink({ supportUrl: 'javascript:alert(1)', supportEmail: 'a@b.com' }))
      .toBe('mailto:a@b.com');
  });

  it('returns undefined when neither is usable, so the caller hides the link', () => {
    expect(supportLink({})).toBeUndefined();
    expect(supportLink({ supportEmail: 'not-an-email' })).toBeUndefined();
  });
});
