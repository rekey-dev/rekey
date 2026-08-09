/**
 * PayPal reports and accepts amounts in the currency's own units, so the scale
 * factor is part of the amount's meaning. Getting it wrong is a clean 100×,
 * straight into the operator's revenue figures — and on the currencies PayPal
 * takes no decimals on, it also makes checkout creation fail outright.
 *
 * The set is PayPal's, not ISO 4217's, because they disagree: ISO calls ISK
 * zero-decimal, PayPal accepts decimals for it. A shared cross-provider table
 * would be wrong for somebody, which is why this one lives beside the module
 * that talks to PayPal.
 */
import { describe, expect, it } from 'vitest';
import {
  paypalScale,
  paypalMajorString,
} from '../src/modules/billing/providers/paypal-money.js';

describe('inbound: provider decimal string to integer minor units', () => {
  it('a zero-decimal currency is already in its smallest unit', () => {
    // "5000" JPY IS 5000. Scaling by 100 recorded ¥500,000.
    expect(paypalScale('JPY')).toBe(1);
    expect(Math.round(5000 * paypalScale('JPY'))).toBe(5000);
  });

  it.each(['HUF', 'TWD'])('%s takes no decimals at PayPal either', (c) => {
    expect(paypalScale(c)).toBe(1);
  });

  it('ISK follows PayPal, not ISO — PayPal accepts decimals for it', () => {
    // Using ISO here would have introduced a fresh 100× error in the opposite
    // direction while fixing the yen one.
    expect(paypalScale('ISK')).toBe(100);
  });

  it('the common case is unchanged, and is case/whitespace insensitive', () => {
    expect(paypalScale('USD')).toBe(100);
    expect(paypalScale(' jpy ')).toBe(1);
    expect(paypalScale(undefined)).toBe(100);
  });
});

describe('outbound: integer minor units to the string PayPal expects', () => {
  it('a zero-decimal plan is sent without a decimal point', () => {
    // A ¥5000 plan stores amount = 5000, because the yen IS the minor unit. It
    // used to be sent as "50.00": a hundredth of the price, AND a decimal
    // point PayPal rejects for JPY — so the checkout failed rather than merely
    // undercharging.
    expect(paypalMajorString(5000, 'JPY')).toBe('5000');
    expect(paypalMajorString(5000, 'HUF')).toBe('5000');
    expect(paypalMajorString(0, 'JPY')).toBe('0');
  });

  it('a two-decimal plan is unchanged', () => {
    expect(paypalMajorString(4999, 'USD')).toBe('49.99');
    expect(paypalMajorString(5000, 'ISK')).toBe('50.00');
  });
});
