import { describe, expect, it } from 'vitest';
import {
  ineligibleReason,
  isTemplateKey,
  markUndeclared,
  parseLinkDomains,
  parseVariableSchema,
  splitUndeclared,
  starterHtml,
} from '../src/lib/custom-email';

describe('custom email form parsing', () => {
  it('explains why a pool or unconfigured Application cannot use custom templates', () => {
    expect(ineligibleReason({ eligible: true, transport: 'byo_resend' })).toBeNull();
    expect(ineligibleReason({ eligible: false, transport: 'default_resend' })).toContain(
      'Connect your own Resend or SMTP in Settings to use custom templates',
    );
    expect(ineligibleReason({ eligible: false, transport: 'none' })).toContain('no email provider');
  });

  it('accepts the API key format only', () => {
    expect(isTemplateKey('order_shipped')).toBe(true);
    for (const bad of ['Order', 'ab', '1abc', 'order-shipped', 'a'.repeat(65)]) expect(isTemplateKey(bad)).toBe(false);
  });

  it('parses the variable editor rows, dropping blank rows and applying defaults', () => {
    const parsed = parseVariableSchema(
      JSON.stringify([
        { name: 'orderNumber', type: 'string', required: true, maxLength: 32 },
        { name: '', type: 'string', required: false, maxLength: 256 },
        { name: 'trackingUrl', type: 'url', required: true, maxLength: 512, sample: 'https://t.example.com/1' },
      ]),
    );
    expect(parsed).toEqual({
      ok: true,
      defs: [
        { name: 'orderNumber', type: 'string', required: true, maxLength: 32 },
        { name: 'trackingUrl', type: 'url', required: true, maxLength: 512, sample: 'https://t.example.com/1' },
      ],
    });
    expect(parseVariableSchema('')).toEqual({ ok: true, defs: [] });
  });

  it('refuses a bad name, a duplicate, and unreadable input', () => {
    expect(parseVariableSchema(JSON.stringify([{ name: '1bad', type: 'string', required: false, maxLength: 5 }])).ok).toBe(
      false,
    );
    const dup = parseVariableSchema(
      JSON.stringify([
        { name: 'a', type: 'string', required: false, maxLength: 5 },
        { name: 'a', type: 'number', required: false, maxLength: 5 },
      ]),
    );
    expect(dup).toEqual({ ok: false, error: '"a" is declared twice.' });
    expect(parseVariableSchema('{not json').ok).toBe(false);
  });

  it('reads link domains one per line, lowercased and deduplicated, and names the invalid ones', () => {
    expect(parseLinkDomains('Track.Example.com\nlinks.example.com, track.example.com')).toEqual({
      domains: ['track.example.com', 'links.example.com'],
      invalid: [],
    });
    expect(parseLinkDomains('https://example.com\nexample.com/path\nlocalhost').invalid).toEqual([
      'https://example.com',
      'example.com/path',
      'localhost',
    ]);
  });

  it('starts a new template with a paragraph per variable, links as links', () => {
    const html = starterHtml([
      { name: 'name', type: 'string', required: false, maxLength: 256 },
      { name: 'trackingUrl', type: 'url', required: true, maxLength: 256 },
    ]);
    expect(html).toContain('<p>{{name}}</p>');
    expect(html).toContain('<a href="{{trackingUrl}}">');
  });
});

describe('undeclared variables in the preview', () => {
  it('highlights the token in body text and leaves attribute values intact', () => {
    const html = markUndeclared('<p>Your order {{orderId}} shipped</p><a href="https://x.test/{{orderId}}">t</a>', [
      'orderId',
    ]);
    expect(html).toMatch(/<p>Your order <mark style="[^"]+">\{\{orderId\}\}<\/mark> shipped<\/p>/);
    expect(html).toContain('<a href="https://x.test/{{orderId}}">');
  });

  it('changes nothing when every variable is declared', () => {
    expect(markUndeclared('<p>{{name}}</p>', [])).toBe('<p>{{name}}</p>');
    expect(splitUndeclared('Hi {{name}}', [])).toEqual([{ text: 'Hi {{name}}', undeclared: false }]);
  });

  it('splits the subject around each undeclared token', () => {
    expect(splitUndeclared('Your order {{orderId}} shipped', ['orderId'])).toEqual([
      { text: 'Your order ', undeclared: false },
      { text: '{{orderId}}', undeclared: true },
      { text: ' shipped', undeclared: false },
    ]);
  });
});
