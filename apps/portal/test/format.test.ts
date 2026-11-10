/**
 * What the portal writes for a plan's price, a subscription's price and a
 * refund. A plan's amount is the API's resolved `price.formatted`; only
 * payments are formatted here, through the currency registry.
 */

import { describe, expect, it } from 'vitest';
import { formatDate, formatMoney, formatPlanPrice, planPriceBesideName, refundLine, subscriptionPriceLabel } from '@/lib/format';
import { statusLabel } from '@/components/status-badge';
import { PLANS, subscription } from './fixtures/billing';

const priced = (formatted: string) => ({ isFree: false, price: { formatted } });

describe('planPriceBesideName', () => {
  it('leaves out a price that would only repeat the name, whatever its case', () => {
    expect(planPriceBesideName(PLANS.free)).toBeNull();
    expect(planPriceBesideName({ ...PLANS.free, name: 'FREE' })).toBeNull();
  });

  it('keeps the price beside any other name', () => {
    expect(planPriceBesideName({ ...PLANS.free, name: 'Starter' })).toBe('Free');
    expect(planPriceBesideName(PLANS.proDefault)).toBe('$19.00 /month');
  });
});

describe('formatPlanPrice', () => {
  it('shows the price resolved for this buyer, not the plan default', () => {
    expect(formatPlanPrice(PLANS.proDefault)).toBe('$19.00 /month');
    expect(formatPlanPrice(PLANS.proInIndia)).toBe('₹1,499.00 /month');
    expect(PLANS.proInIndia).not.toHaveProperty('amount');
  });

  it('renders a free plan as "Free", not as a price', () => {
    expect(formatPlanPrice(PLANS.free)).toBe('Free');
  });

  it('does not call a metered plan with no base fee free', () => {
    expect(formatPlanPrice(PLANS.metered)).toBe('Billed by usage');
  });

  it('renders a one-time licence with no cadence', () => {
    // `interval` defaults to MONTH server-side for every kind.
    expect(formatPlanPrice({ ...priced('$499.00'), kind: 'LICENSE', interval: 'MONTH' })).toBe('$499.00');
  });

  it('renders a credit pack with the credits it grants', () => {
    expect(formatPlanPrice({ ...priced('$9.00'), kind: 'CREDIT', creditsAmount: 500 })).toBe('$9.00 · 500 credits');
    expect(formatPlanPrice({ ...priced('$9.00'), kind: 'CREDIT', creditsAmount: null })).toBe('$9.00');
  });

  it('does not append a cadence when interval is null', () => {
    expect(formatPlanPrice({ ...priced('$9.00'), kind: 'SUBSCRIPTION', interval: null })).toBe('$9.00');
  });
});

describe('subscriptionPriceLabel', () => {
  it("shows the subscription's own price and currency, whatever the plan's default is", () => {
    const sub = subscription();
    expect(subscriptionPriceLabel(sub.price, PLANS.proDefault)).toBe('₹1,499.00 /month');
  });

  it('says nothing for a subscription with no price, and keeps the price when the plan is gone', () => {
    expect(subscriptionPriceLabel(null, PLANS.proDefault)).toBeNull();
    expect(subscriptionPriceLabel({ formatted: '$19.00' }, undefined)).toBe('$19.00');
  });
});

describe('refundLine', () => {
  it('is silent when nothing was refunded', () => {
    expect(refundLine({ amount: 1900, currency: 'USD', refundedAmount: 0 }, 'en-US')).toBeNull();
  });

  it("names the part refunded and the charge, in the payment's own currency", () => {
    expect(refundLine({ amount: 1900, currency: 'USD', refundedAmount: 500 }, 'en-US')).toBe('Refunded $5.00 of $19.00');
    expect(refundLine({ amount: 1500, currency: 'JPY', refundedAmount: 500 }, 'en-US')).toBe('Refunded ¥500 of ¥1,500');
  });

  it('names only the amount for a full refund', () => {
    expect(refundLine({ amount: 149900, currency: 'INR', refundedAmount: 149900 }, 'en-US')).toBe('Refunded ₹1,499.00');
  });
});

describe('formatMoney, the registry formatter', () => {
  // The API stores every amount at the ISO 4217 exponent, whatever number of
  // decimals a locale shows for the currency.
  it.each([
    ['USD', 1999, '$19.99'],
    ['JPY', 1500, '¥1,500'],
    ['HUF', 500000, 'HUF\u00a05,000'],
    ['INR', 149900, '₹1,499.00'],
    ['EUR', 1999, '€19.99'],
    ['UGX', 500000, 'UGX\u00a0500,000'],
  ])('%s %i reads %s', (currency, minor, shown) => {
    expect(formatMoney(minor, currency, 'en-US')).toBe(shown);
  });

  it('renders zero as an amount, and refuses a fraction of a minor unit', () => {
    expect(formatMoney(0, 'USD', 'en-US')).toBe('$0.00');
    expect(() => formatMoney(9.5, 'USD', 'en-US')).toThrow(RangeError);
  });
});

describe('formatMoney in the visitor locale', () => {
  it("groups an Indian visitor's amounts in lakhs", () => {
    expect(formatMoney(1500000000, 'INR', 'en-IN')).toBe('₹1,50,00,000.00');
    expect(formatMoney(1500000000, 'INR', 'en-US')).toBe('₹15,000,000.00');
  });
});

describe('formatDate, every date the portal shows', () => {
  it('writes the medium date in the given locale', () => {
    expect(formatDate('2026-10-15T12:00:00Z', 'en-US', 'UTC')).toBe('Oct 15, 2026');
    expect(formatDate('2026-10-15T12:00:00Z', 'en-IN', 'UTC')).toBe('15 Oct 2026');
  });

  it("reads the day in the given zone, not the server's", () => {
    expect(formatDate('2026-10-15T23:30:00Z', 'en-US', 'UTC')).toBe('Oct 15, 2026');
    expect(formatDate('2026-10-15T23:30:00Z', 'en-US', 'Asia/Kolkata')).toBe('Oct 16, 2026');
  });
});

describe("the words for a plan's cadence and a status", () => {
  it('names the cadence from copy, and leaves an interval it does not know unnamed', () => {
    expect(formatPlanPrice({ ...priced('$190.00'), kind: 'SUBSCRIPTION', interval: 'YEAR' })).toBe('$190.00 /year');
    expect(formatPlanPrice({ ...priced('$5.00'), kind: 'SUBSCRIPTION', interval: 'FORTNIGHT' })).toBe('$5.00');
  });

  it('labels a status in customer words, never the enum name', () => {
    expect(statusLabel('SUCCEEDED')).toBe('Paid');
    expect(statusLabel('PAST_DUE')).toBe('Past due');
    expect(statusLabel('PARTIALLY_REFUNDED')).toBe('Partially refunded');
    expect(statusLabel('SOMETHING_NEW')).toBe('Unknown');
  });
});
