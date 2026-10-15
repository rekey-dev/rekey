/**
 * PayPal reports and accepts amounts as decimal strings in the currency's own
 * units, so the scale is part of the amount's meaning. Getting it wrong is a
 * clean 100x straight into the operator's revenue figures, and on the
 * currencies PayPal takes no decimals on it also makes checkout creation fail
 * outright.
 *
 * A stored amount is at the ISO 4217 exponent. The no-decimals set is
 * PayPal's own, and the two disagree on HUF and TWD: ISO gives them two
 * places and PayPal takes none.
 */
import { describe, expect, it } from 'vitest';
import {
  PAYPAL_NO_DECIMALS,
  paypalMinorFromMajor,
  toProviderAmount,
} from '../src/modules/billing/providers/paypal-money.js';

describe('inbound: provider decimal string to stored minor units', () => {
  it('a zero-decimal currency is already in its smallest unit', () => {
    // "5000" JPY IS 5000. Scaling by 100 recorded 500,000 yen.
    expect(paypalMinorFromMajor('5000', 'JPY')).toBe(5000);
  });

  it.each(['HUF', 'TWD'])('%s arrives in whole units and is stored at two places', (c) => {
    expect(PAYPAL_NO_DECIMALS.has(c)).toBe(true);
    expect(paypalMinorFromMajor('5000', c)).toBe(500000);
  });

  it('an amount with no currency has no scale', () => {
    expect(paypalMinorFromMajor('49.99', undefined)).toBeNull();
  });
});

describe('outbound: stored minor units to the string PayPal expects', () => {
  it('a no-decimals plan is sent without a decimal point', () => {
    // A 5000 yen plan stores 5000, because the yen IS the minor unit. It used
    // to be sent as "50.00": a hundredth of the price, AND a decimal point
    // PayPal rejects for JPY.
    expect(toProviderAmount('JPY', 5000)).toBe('5000');
    expect(toProviderAmount('JPY', 0)).toBe('0');
    // A 5000 Ft plan stores 500000: HUF has two places in ISO.
    expect(toProviderAmount('HUF', 500000)).toBe('5000');
  });

  it('a zero-decimal currency PayPal takes decimals on gets ".00"', () => {
    expect(toProviderAmount('ISK', 5000)).toBe('5000.00');
  });
});
