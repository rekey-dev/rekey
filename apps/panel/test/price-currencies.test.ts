/**
 * The currency picker's rules: what it offers, which currencies it marks as
 * not chargeable, and which provider change would fix each.
 */

import { describe, expect, it } from 'vitest';
import {
  amountRule,
  chargesNow,
  currencyChoice,
  notSoldReason,
  priceCurrencyChoices,
  toChargingProviders,
  unchargeableReason,
  type ChargingProvider,
} from '@/lib/price-currencies';

const status = (currencies: string[], over: Partial<NonNullable<ChargingProvider['status']>> = {}) => ({
  enabled: true,
  currencies,
  unsupportedCurrencies: [],
  ...over,
});

const stripe: ChargingProvider = {
  name: 'stripe',
  label: 'Stripe',
  supportedCurrencies: 'all-sellable',
  capabilities: {},
  status: status(['USD', 'EUR']),
};
const razorpay: ChargingProvider = {
  name: 'razorpay',
  label: 'Razorpay',
  supportedCurrencies: ['INR', 'USD'],
  capabilities: {},
  status: null,
};
const external: ChargingProvider = {
  name: 'external',
  label: 'Your billing system',
  supportedCurrencies: 'all-sellable',
  capabilities: { checkout: false },
  status: status([]),
};

describe('chargesNow', () => {
  it('follows the ticked currencies of an enabled provider', () => {
    expect(chargesNow(stripe, 'USD')).toBe(true);
    expect(chargesNow(stripe, 'INR')).toBe(false);
  });

  it('reads an empty list as no currency, which is what the API does', () => {
    expect(chargesNow({ ...stripe, status: status([]) }, 'INR')).toBe(false);
    expect(chargesNow({ ...stripe, status: status([]) }, 'USD')).toBe(false);
  });

  it('never counts a disabled, unconnected or inbound-only provider', () => {
    expect(chargesNow({ ...stripe, status: status(['USD'], { enabled: false }) }, 'USD')).toBe(false);
    expect(chargesNow(razorpay, 'INR')).toBe(false);
    expect(chargesNow(external, 'USD')).toBe(false);
  });

  it('skips a stored currency the provider cannot charge at all', () => {
    const paypal = { ...stripe, status: status(['USD', 'INR'], { unsupportedCurrencies: ['INR'] }) };
    expect(chargesNow(paypal, 'INR')).toBe(false);
  });
});

describe('currencyChoice', () => {
  it('names who charges a currency', () => {
    expect(currencyChoice('usd', [stripe, razorpay]).chargedBy).toEqual(['Stripe']);
    expect(unchargeableReason(currencyChoice('USD', [stripe, razorpay]))).toBeNull();
  });

  it('says which provider change would let a currency be charged', () => {
    const inr = currencyChoice('INR', [stripe, razorpay, external]);
    expect(inr.chargedBy).toEqual([]);
    expect(inr.couldCharge).toEqual([
      { label: 'Stripe', repair: 'tick_currency' },
      { label: 'Razorpay', repair: 'connect' },
    ]);
    expect(unchargeableReason(inr)).toBe(
      'No enabled provider can charge INR. To sell in it: tick INR on Stripe, or connect Razorpay.',
    );
  });

  it('offers no repair through a provider that does not publish the currency', () => {
    const onlyRazorpay = [{ ...razorpay, status: status(['INR']) }];
    const eur = currencyChoice('EUR', onlyRazorpay);
    expect(eur.couldCharge).toEqual([]);
    expect(unchargeableReason(eur)).toContain('No provider Rekey supports can charge EUR');
  });

  it('tells a disabled provider apart from an unconnected one', () => {
    const disabled = { ...razorpay, status: status(['INR'], { enabled: false }) };
    expect(currencyChoice('INR', [disabled]).couldCharge).toEqual([{ label: 'Razorpay', repair: 'enable' }]);
  });
});

describe('priceCurrencyChoices', () => {
  const codes = priceCurrencyChoices([stripe], 'INR').map((choice) => choice.code);

  it('leads with the reporting currency', () => {
    expect(codes[0]).toBe('INR');
  });

  it('never offers a three-decimal currency or a code that is not money', () => {
    for (const code of ['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD', 'XAU', 'XXX']) {
      expect(codes).not.toContain(code);
    }
    expect(codes).toContain('JPY');
    expect(codes).toContain('HUF');
  });
});

describe('notSoldReason', () => {
  it('accepts a sellable code in any case and an empty field', () => {
    expect(notSoldReason('usd')).toBeNull();
    expect(notSoldReason('')).toBeNull();
  });

  it('refuses a three-decimal currency with the reason', () => {
    expect(notSoldReason('KWD')).toContain('three decimals');
  });

  it('refuses a code that is not a currency', () => {
    expect(notSoldReason('ZZZ')).toContain('not a currency Rekey knows');
    expect(notSoldReason('US')).toContain('three-letter code');
  });
});

describe('amountRule', () => {
  it('says how each kind of currency is typed', () => {
    expect(amountRule('USD')).toBe('Up to 2 decimals, such as 19.99.');
    expect(amountRule('JPY')).toContain('no decimals');
    for (const code of ['HUF', 'TWD', 'MGA']) expect(amountRule(code)).toContain('whole units');
    expect(amountRule('ZZZ')).toBeNull();
  });
});

describe('toChargingProviders', () => {
  it('keeps what the picker reads and nothing else', () => {
    const descriptor = { ...stripe, credentialFields: [{ key: 'secretKey' }], docsUrl: 'https://example.test' };
    const [compact] = toChargingProviders([descriptor]);
    expect(compact).toEqual(stripe);
    expect(chargesNow(compact!, 'USD')).toBe(true);
  });
});
