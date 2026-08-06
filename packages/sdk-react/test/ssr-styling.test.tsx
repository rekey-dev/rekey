/**
 * The components must be usable without shipping React to the browser.
 *
 * The stylesheet used to be appended to `document.head` from a `useEffect`.
 * That works in Next, where these hydrate anyway, and fails everywhere they
 * are rendered server-only: Astro without a client directive produced correct
 * markup with no styling at all. The workaround was `client:load`, which ships
 * React to a page that needs none purely to obtain a stylesheet — so the whole
 * component set was effectively Next-only.
 *
 * `renderToStaticMarkup` is exactly that condition: no hydration, no effects.
 */
import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignIn, PricingTable, CheckoutButton, RekeyStyles } from '../src/index.js';

const sheets = (html: string) => (html.match(/data-rekey-styles/g) ?? []).length;

const PLANS = [
  {
    id: 'p1',
    slug: 'pro',
    name: 'Pro',
    amount: 2900,
    currency: 'USD',
    interval: 'MONTH' as const,
    kind: 'SUBSCRIPTION' as const,
    active: true,
  },
];

describe('server-only rendering', () => {
  it('carries its own styles, with no client JavaScript', () => {
    const html = renderToStaticMarkup(<SignIn actionUrl="/api/sign-in" />);
    expect(sheets(html)).toBe(1);
    // Not merely a <style> tag — the actual rules the classNames reference.
    expect(html).toContain('.rekey-card');
    expect(html).toContain('action="/api/sign-in"');
  });

  it('uses a data attribute, so sibling copies stay valid HTML', () => {
    const html = renderToStaticMarkup(
      <div>
        <SignIn actionUrl="/a" />
        <SignIn actionUrl="/b" />
      </div>,
    );
    expect(sheets(html)).toBe(2);
    expect(html).not.toContain('id="rekey-react-styles"');
  });

  it('emits one sheet for a whole tree under <RekeyStyles>', () => {
    const html = renderToStaticMarkup(
      <RekeyStyles>
        <SignIn actionUrl="/a" />
        <SignIn actionUrl="/b" />
      </RekeyStyles>,
    );
    expect(sheets(html)).toBe(1);
  });
});

describe('billing without Server Actions', () => {
  it('posts a plain form to checkoutUrl', () => {
    const html = renderToStaticMarkup(<PricingTable plans={PLANS} checkoutUrl="/api/checkout" />);
    const form = html.match(/<form[^>]*>/)![0];
    expect(form).toContain('action="/api/checkout"');
    expect(form).toContain('method="post"');
    expect(html).toContain('name="planSlug"');
    expect(html).toContain('value="pro"');
  });

  it('still accepts a Server Action, which must not become a URL post', () => {
    const html = renderToStaticMarkup(
      <PricingTable plans={PLANS} checkoutAction={() => {}} />,
    );
    expect(html).toContain('<form');
    expect(html).not.toContain('method="post"');
  });

  it('gives CheckoutButton the same choice', () => {
    const html = renderToStaticMarkup(<CheckoutButton planSlug="pro" actionUrl="/api/checkout" />);
    const form = html.match(/<form[^>]*>/)![0];
    expect(form).toContain('action="/api/checkout"');
    expect(form).toContain('method="post"');
  });

  it('renders nothing actionable when given neither', () => {
    // Better an inert button than a form that silently posts to the page.
    const html = renderToStaticMarkup(<CheckoutButton planSlug="pro" />);
    const form = html.match(/<form[^>]*>/)![0];
    expect(form).not.toContain('action=');
  });
});
