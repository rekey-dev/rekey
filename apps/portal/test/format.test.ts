/**
 * Pins every plan shape the portal can render a price for.
 *
 * `lib/format.ts` is a deliberate copy of `formatPrice` in `@rekey.dev/react`
 * (that module is client-only and this app renders plans on the server). A copy
 * only stays honest if something fails when it drifts — these assertions are
 * that something. Each expectation below is what the SDK produces for the same
 * plan, except where the file's docblock records a known, deliberate difference.
 */

import { describe, expect, it } from 'vitest';
import { formatMoney, formatPlanPrice, minorUnitDivisor } from '@/lib/format';

describe('formatPlanPrice — the six plan shapes', () => {
  it('renders a free tier as "Free", not as a price', () => {
    // Was: "$0.00/month". A free plan has no cadence and no amount.
    expect(formatPlanPrice({ amount: 0, currency: 'USD', kind: 'SUBSCRIPTION', interval: 'MONTH' }))
      .toBe('Free');
  });

  it('renders a monthly subscription with its cadence', () => {
    expect(formatPlanPrice({ amount: 900, currency: 'USD', kind: 'SUBSCRIPTION', interval: 'MONTH' }))
      .toBe('$9 /month');
  });

  it('keeps cents when the amount is not a whole unit', () => {
    expect(formatPlanPrice({ amount: 999, currency: 'USD', kind: 'SUBSCRIPTION', interval: 'MONTH' }))
      .toBe('$9.99 /month');
  });

  it('renders a one-time licence with no cadence and no "one-time" suffix', () => {
    // `interval` defaults to MONTH server-side for EVERY kind, which is how a
    // perpetual licence came to be advertised as "$499.00/month".
    expect(formatPlanPrice({ amount: 49900, currency: 'USD', kind: 'LICENSE', interval: 'MONTH' }))
      .toBe('$499');
  });

  it('renders a credit pack with the credits it grants', () => {
    // Was: "$9.00 one-time" — which drops the only fact that distinguishes one
    // credit pack from another.
    expect(formatPlanPrice({ amount: 900, currency: 'USD', kind: 'CREDIT', creditsAmount: 500 }))
      .toBe('$9 · 500 credits');
  });

  it('renders a usage plan as a bare amount', () => {
    expect(formatPlanPrice({ amount: 5, currency: 'USD', kind: 'USAGE', interval: 'MONTH' }))
      .toBe('$0.05');
  });

  it('does not append a cadence when interval is null', () => {
    expect(formatPlanPrice({ amount: 900, currency: 'USD', kind: 'SUBSCRIPTION', interval: null }))
      .toBe('$9');
  });

  it('falls back to a CREDIT plan with no creditsAmount rendering the bare amount', () => {
    expect(formatPlanPrice({ amount: 900, currency: 'USD', kind: 'CREDIT', creditsAmount: null }))
      .toBe('$9');
  });
});

describe('minor units', () => {
  it('treats most currencies as hundredths', () => {
    expect(minorUnitDivisor('USD')).toBe(100);
    expect(minorUnitDivisor('eur')).toBe(100);
    expect(minorUnitDivisor('INR')).toBe(100);
  });

  it('treats zero-decimal currencies as whole units', () => {
    expect(minorUnitDivisor('JPY')).toBe(1);
    expect(minorUnitDivisor('KRW')).toBe(1);
  });

  it('treats three-decimal currencies as thousandths', () => {
    expect(minorUnitDivisor('KWD')).toBe(1000);
  });

  // The 100x bug: a ¥1000 plan is ¥1000, not ¥10. Dividing every currency by
  // 100 understates a JPY price by two orders of magnitude, to a paying
  // customer. This is the one case where this module deliberately diverges from
  // the SDK, which still divides unconditionally.
  it('does not divide a JPY amount', () => {
    expect(formatPlanPrice({ amount: 1000, currency: 'JPY', kind: 'SUBSCRIPTION', interval: 'MONTH' }))
      .toBe('¥1,000 /month');
  });
});

describe('formatMoney — billing history uses the same renderer as the plan list', () => {
  it('drops .00 on whole amounts and keeps cents otherwise', () => {
    expect(formatMoney(900, 'USD')).toBe('$9');
    expect(formatMoney(999, 'USD')).toBe('$9.99');
  });

  it('uses the SDK symbol table, including its unknown-code fallback', () => {
    expect(formatMoney(1000, 'GBP')).toBe('£10');
    expect(formatMoney(1000, 'AUD')).toBe('AUD 10');
  });

  it('renders zero as an amount, not as "Free" (that rule is plan-level only)', () => {
    expect(formatMoney(0, 'USD')).toBe('$0');
  });
});
