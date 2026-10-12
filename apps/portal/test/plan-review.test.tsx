/**
 * The page a buyer reviews one plan on before checkout: the price they will
 * be charged, the notice when it is not the price for their currency, and a
 * coupon code that can be refused without stopping them from paying.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlanReview } from '@/components/plan-review';
import type { CouponQuote } from '@/lib/coupon-quote';
import { COUPON_QUOTE, COUPON_QUOTE_WITH_FALLBACK, PLANS } from './fixtures/billing';

function render(over: Partial<Parameters<typeof PlanReview>[0]> = {}): string {
  return renderToStaticMarkup(
    <PlanReview
      slug="acme"
      plan={PLANS.proDefault}
      switching={false}
      team={null}
      coupon={null}
      providers={[]}
      routedProvider={null}
      reviewPath="/acme/plans/pro"
      action={async () => undefined}
      {...over}
    />,
  );
}

/** The checkout form: the one that is not the GET coupon form. */
function checkoutForm(html: string): string {
  const form = html.split('<form').find((chunk) => chunk.includes('name="planSlug"'));
  if (!form) throw new Error('no checkout form');
  return form;
}

const payButton = (html: string): string => /<button[^>]*type="submit"[^>]*>Continue to checkout<\/button>/.exec(checkoutForm(html))?.[0] ?? '';

describe('plan review, the price', () => {
  it('shows the price this buyer will be charged and its currency', () => {
    const html = render({ plan: PLANS.proInIndia });
    expect(html).toContain('₹1,499.00 /month');
    expect(html).toContain('Charged in INR.');
    expect(html).not.toContain('$19.00');
  });

  it('says so before checkout when the price for their currency cannot be charged', () => {
    const html = render({ plan: PLANS.proFallback });
    expect(html).toContain('A price in INR is not available yet. You will pay $19.00 (USD).');
  });

  it('shows no notice when the price shown is the one selected for the buyer', () => {
    expect(render({ plan: PLANS.proDefault })).not.toContain('not available yet');
    expect(render({ plan: PLANS.proInIndia })).not.toContain('not available yet');
  });

  it('names both currencies when a coupon quote carries the fallback', () => {
    const html = render({
      plan: PLANS.proFallback,
      coupon: { kind: 'quote', code: 'SPRING15', quote: COUPON_QUOTE_WITH_FALLBACK },
    });
    expect(html).toContain('Prices in INR are not available yet. You will pay $19.00 (USD).');
  });
});

describe('plan review, a coupon code', () => {
  it("shows the API's discount and total, and sends the code to checkout", () => {
    const html = render({ coupon: { kind: 'quote', code: 'SPRING15', quote: COUPON_QUOTE } });
    // The code as the buyer typed it, not as the API stores it.
    expect(html).toContain('Code SPRING15');
    expect(html).toContain('−$2.85');
    expect(html).toContain('$16.15');
    expect(checkoutForm(html)).toMatch(/<input[^>]*name="couponCode"[^>]*value="SPRING15"/);
  });

  it.each<[string, CouponQuote]>([
    ['refused', { kind: 'refused', code: 'SPRING15', message: 'Coupon "SPRING15" does not work for prices in INR.' }],
    ['could not be checked', { kind: 'unavailable', code: 'SPRING15' }],
  ])('a code that is %s leaves the pay button usable, at full price', (_label, coupon) => {
    const html = render({ plan: PLANS.proInIndia, coupon });
    expect(payButton(html)).not.toBe('');
    expect(payButton(html)).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(checkoutForm(html)).not.toContain('name="couponCode"');
    expect(html).toContain('You can continue without the code and pay ₹1,499.00.');
  });

  it("shows a refusal in the API's own words", () => {
    const message = 'Coupon "SPRING15" does not work for prices in INR.';
    const html = render({ coupon: { kind: 'refused', code: 'SPRING15', message } });
    expect(html).toContain('Coupon &quot;SPRING15&quot; does not work for prices in INR.');
    expect(html).toMatch(/role="alert"/);
  });

  it('offers no coupon field on a plan with nothing to discount', () => {
    expect(render({ plan: PLANS.metered })).not.toContain('name="coupon"');
  });
});

describe('plan review, the payment provider', () => {
  const providers = [
    { provider: 'razorpay', priority: 1, countries: [] },
    { provider: 'stripe', priority: 2, countries: [] },
  ];

  it('offers a choice only between several, with the routed one checked', () => {
    expect(render({ providers: [providers[0]!] })).not.toContain('type="radio"');
    const html = render({ providers, routedProvider: 'stripe' });
    const checked = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].filter((m) => m[0].includes('checked'));
    expect(checked.map((m) => /value="([^"]+)"/.exec(m[0])![1])).toEqual(['stripe']);
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="providerPreselected"[^>]*value="stripe"/);
  });
});
