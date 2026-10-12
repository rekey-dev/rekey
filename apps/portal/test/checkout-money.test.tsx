/**
 * The hosted checkout page's money: every figure is the session's own, in the
 * session's currency, and the buyer is told before paying when the price is
 * not the one for their currency.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CheckoutView } from '@/components/checkout/checkout-view';
import { CHECKOUT_WITH_FALLBACK, checkoutView } from './fixtures/billing';

type Money = Parameters<typeof checkoutView>[0];

function render(money: Money, priceFallback?: typeof CHECKOUT_WITH_FALLBACK.priceFallback): string {
  const view = checkoutView(money);
  return renderToStaticMarkup(
    <CheckoutView
      view={view}
      order={priceFallback === undefined ? view.order : { ...view.order, priceFallback }}
      nonce="n"
      basePath="/acme/checkout/chk_live_x"
      locale="en-US"
    />,
  );
}

/** The text of the "Total due today" row. */
function totalRow(html: string): string {
  const row = /Total due today.*?<\/dd>/s.exec(html)?.[0];
  if (!row) throw new Error('no total row');
  return row.replace(/<[^>]+>/g, ' ');
}

describe('checkout page, the total', () => {
  // The server's `totalDueToday` is deliberately NOT amount minus discount in
  // these rows: a page that worked the total out for itself would print the
  // difference, and the buyer would be charged another figure.
  it.each<[string, Money, string, string]>([
    ['USD', { currency: 'USD', amount: 1900, discountAmount: 285, totalDueToday: 1610 }, '$16.10', '$16.15'],
    ['JPY', { currency: 'JPY', amount: 1500, discountAmount: 225, totalDueToday: 1270 }, '¥1,270', '¥1,275'],
    ['HUF', { currency: 'HUF', amount: 499000, discountAmount: 74900, totalDueToday: 424000 }, 'HUF 4,240', 'HUF 4,241'],
  ])('%s: shows the figure the server sent, in that currency', (currency, money, shown, recomputed) => {
    const html = render(money);
    expect(totalRow(html)).toContain(shown);
    expect(totalRow(html)).toContain(`(${currency})`);
    expect(html).not.toContain(recomputed);
    expect(html).toContain(`Pay ${shown}`);
  });

  it.each<[string, Money, string, string, string]>([
    ['USD', { currency: 'USD', amount: 1900, discountAmount: 285, totalDueToday: 1615 }, '$19.00', '−$2.85', '$16.15'],
    ['JPY', { currency: 'JPY', amount: 1500, discountAmount: 225, totalDueToday: 1275 }, '¥1,500', '−¥225', '¥1,275'],
    ['HUF', { currency: 'HUF', amount: 499000, discountAmount: 74900, totalDueToday: 424100 }, 'HUF 4,990', '−HUF 749', 'HUF 4,241'],
  ])('%s: shows the price, the discount and the total, never divided by 100', (_c, money, price, discount, total) => {
    const html = render(money);
    expect(html).toContain(price);
    expect(html).toContain(discount);
    expect(totalRow(html)).toContain(total);
  });

  it('charges nothing today on a trial, and still names the renewal price', () => {
    const html = render({ currency: 'JPY', amount: 1500, discountAmount: 0, totalDueToday: 0 });
    expect(totalRow(html)).toContain('¥0');
    expect(html).toContain('Renews automatically at ¥1,500 every month until you cancel.');
  });
});

describe('checkout page, the price fallback notice', () => {
  const usd = { currency: 'USD', amount: 1900, discountAmount: 0, totalDueToday: 1900 };

  it('tells the buyer what they will be charged, and in which currency, before the payment form', () => {
    const html = render(usd, CHECKOUT_WITH_FALLBACK.priceFallback);
    const notice = 'Prices in INR are not available yet. You will pay $19.00 (USD).';
    expect(html).toContain(notice);
    expect(html.indexOf(notice)).toBeLessThan(html.indexOf('id="payment-heading"'));
    expect(html).toMatch(/role="group"[^>]*aria-describedby="price-fallback charge-disclosure"/);
  });

  it('shows no notice when the session carries no fallback', () => {
    for (const html of [render(usd), render(usd, null)]) {
      expect(html).not.toContain('not available yet');
      expect(html).toMatch(/role="group"[^>]*aria-describedby="charge-disclosure"/);
    }
  });
});
