import { describe, expect, it } from 'vitest';
import {
  CURRENCY_TABLE,
  MAX_PRICE_AMOUNT,
  chargeableStep,
  percentageDiscount,
  currencyRecord,
  currencySellability,
  formatMoney,
  isSellableCurrency,
  localCurrencyOf,
  minorUnitExponent,
  sellableCurrencies,
  validatePriceAmount,
} from '../src/currency/index.js';
// @ts-expect-error The generator's inputs are plain ESM with no types.
import { COUNTRY_CURRENCY, ISO_NON_TWO_DECIMAL } from '../scripts/country-currency.mjs';

const countryCurrency = COUNTRY_CURRENCY as Record<string, string | null>;
const isoNonTwoDecimal = ISO_NON_TWO_DECIMAL as Record<string, number>;

describe('the currency table', () => {
  it('holds every currency the country map names', () => {
    for (const [country, currency] of Object.entries(countryCurrency)) {
      if (currency === null) continue;
      expect(CURRENCY_TABLE[currency], `${country} -> ${currency}`).toBeDefined();
    }
  });

  it('covers all 249 ISO 3166-1 alpha-2 countries, each with a well-formed code', () => {
    const countries = Object.keys(countryCurrency);
    expect(countries).toHaveLength(249);
    for (const country of countries) expect(country).toMatch(/^[A-Z]{2}$/);
  });

  it('lists each country under exactly the currency the map gives it', () => {
    for (const [country, currency] of Object.entries(countryCurrency)) {
      const holders = Object.values(CURRENCY_TABLE).filter((record) => record.countries.includes(country));
      expect(holders.map((record) => record.code), country).toEqual(currency === null ? [] : [currency]);
    }
  });

  it('records the ISO 4217 exponent, not the digits Intl displays', () => {
    for (const record of Object.values(CURRENCY_TABLE)) {
      expect(record.exponent, record.code).toBe(isoNonTwoDecimal[record.code] ?? 2);
    }
    expect(minorUnitExponent('HUF')).toBe(2);
    expect(minorUnitExponent('COP')).toBe(2);
    expect(minorUnitExponent('ISK')).toBe(0);
    expect(minorUnitExponent('IQD')).toBe(3);
    expect(minorUnitExponent('LYD')).toBe(3);
  });

  it('keys every row by its own upper-case code and names it', () => {
    for (const [key, record] of Object.entries(CURRENCY_TABLE)) {
      expect(record.code).toBe(key);
      expect(key).toMatch(/^[A-Z]{3}$/);
      expect(record.name.length).toBeGreaterThan(0);
    }
  });

  it('reads a code whatever its case or padding', () => {
    expect(currencyRecord(' usd ')?.code).toBe('USD');
    expect(currencyRecord('ABC')).toBeNull();
    expect(minorUnitExponent('ABC')).toBeNull();
  });
});

describe('isSellableCurrency', () => {
  it('accepts ordinary two-decimal and zero-decimal currencies', () => {
    for (const code of ['USD', 'EUR', 'INR', 'JPY', 'KRW', 'BRL', 'usd']) {
      expect(isSellableCurrency(code), code).toBe(true);
    }
  });

  it('accepts the currencies a provider scales differently from ISO', () => {
    for (const code of ['ISK', 'UGX', 'MGA', 'MRU']) expect(isSellableCurrency(code), code).toBe(true);
  });

  it('refuses codes that are not money', () => {
    for (const code of ['XAU', 'XAG', 'XPT', 'XPD', 'XDR', 'XTS', 'XXX', 'XSU', 'BOV', 'CHE', 'CHW', 'CLF', 'COU', 'MXV', 'USN', 'UYI', 'UYW']) {
      expect(currencySellability(code), code).toEqual({ sellable: false, reason: 'not_money' });
    }
  });

  it('refuses every three-decimal currency, including the two an earlier list missed', () => {
    for (const code of ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']) {
      expect(currencySellability(code), code).toEqual({ sellable: false, reason: 'three_decimal' });
    }
    const threeDecimal = Object.values(CURRENCY_TABLE).filter((record) => record.exponent === 3);
    for (const record of threeDecimal) expect(isSellableCurrency(record.code), record.code).toBe(false);
  });

  it('refuses withdrawn and unknown codes', () => {
    expect(currencySellability('HRK')).toEqual({ sellable: false, reason: 'withdrawn' });
    expect(currencySellability('ZWL')).toEqual({ sellable: false, reason: 'withdrawn' });
    expect(currencySellability('ABC')).toEqual({ sellable: false, reason: 'unknown' });
    expect(currencySellability('')).toEqual({ sellable: false, reason: 'unknown' });
    expect(currencySellability('US')).toEqual({ sellable: false, reason: 'unknown' });
  });

  it('keeps the franc zones sellable although their codes start with X', () => {
    for (const code of ['XAF', 'XOF', 'XPF', 'XCD', 'XCG']) expect(isSellableCurrency(code), code).toBe(true);
  });

  it('marks the forint, the Taiwan dollar and the ariary whole units only', () => {
    for (const code of ['HUF', 'TWD', 'MGA']) {
      expect(currencySellability(code), code).toEqual({ sellable: true, wholeUnitsOnly: true });
    }
    expect(currencySellability('USD')).toEqual({ sellable: true, wholeUnitsOnly: false });
    expect(currencySellability('ISK')).toEqual({ sellable: true, wholeUnitsOnly: false });
  });

  it('lists the sellable set, sorted and consistent with the predicate', () => {
    const list = sellableCurrencies();
    expect(list).toEqual([...list].sort());
    expect(list).toContain('USD');
    expect(list).not.toContain('KWD');
    expect(list).not.toContain('XDR');
    expect(list.every(isSellableCurrency)).toBe(true);
    expect(list.length).toBe(Object.keys(CURRENCY_TABLE).filter(isSellableCurrency).length);
  });
});

describe('validatePriceAmount', () => {
  it('accepts a positive integer in a sellable currency', () => {
    expect(validatePriceAmount('USD', 1999)).toEqual({ ok: true });
    expect(validatePriceAmount('jpy', 1500)).toEqual({ ok: true });
    expect(validatePriceAmount('ISK', 5000)).toEqual({ ok: true });
  });

  it('names the rule a fractional or non-finite amount breaks', () => {
    for (const amount of [19.99, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      const result = validatePriceAmount('USD', amount);
      expect(result.ok === false && result.rule, String(amount)).toBe('not_integer');
    }
  });

  it('names the rule a zero or negative amount breaks', () => {
    for (const amount of [0, -1, -500]) {
      const result = validatePriceAmount('USD', amount);
      expect(result.ok === false && result.rule, String(amount)).toBe('not_positive');
    }
  });

  it('holds a whole-units-only currency to a multiple of 100', () => {
    expect(validatePriceAmount('HUF', 500000)).toEqual({ ok: true });
    expect(validatePriceAmount('TWD', 30000)).toEqual({ ok: true });
    for (const [currency, amount] of [['HUF', 500050], ['TWD', 30001], ['MGA', 150]] as const) {
      const result = validatePriceAmount(currency, amount);
      expect(result.ok === false && result.rule, currency).toBe('not_whole_unit');
    }
    expect(validatePriceAmount('USD', 500050)).toEqual({ ok: true });
  });

  it('refuses an amount the amount column cannot hold', () => {
    expect(MAX_PRICE_AMOUNT).toBe(2_147_483_647);
    expect(validatePriceAmount('USD', 2_147_483_647)).toEqual({ ok: true });
    expect(validatePriceAmount('HUF', 2_147_483_600)).toEqual({ ok: true });
    for (const amount of [2_147_483_648, 3_000_000_000, Number.MAX_SAFE_INTEGER]) {
      const result = validatePriceAmount('USD', amount);
      expect(result.ok === false && result.rule, String(amount)).toBe('too_large');
    }
  });

  it('refuses an unsellable currency before looking at the amount', () => {
    for (const currency of ['KWD', 'XAU', 'ABC']) {
      const result = validatePriceAmount(currency, 1000);
      expect(result.ok === false && result.rule, currency).toBe('currency_not_sellable');
    }
  });

  it('explains every refusal', () => {
    const result = validatePriceAmount('HUF', 150);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('HUF') });
  });
});

/** Intl separates a code from its number with a no-break space. */
const spaced = (text: string): string => text.replace(/\s/g, ' ');

describe('formatMoney', () => {
  it('divides by the registry exponent', () => {
    expect(formatMoney(1999, 'USD')).toBe('$19.99');
    expect(formatMoney(1500, 'JPY')).toBe('¥1,500');
    expect(formatMoney(149900, 'INR')).toBe('₹1,499.00');
    expect(spaced(formatMoney(5000, 'ISK'))).toBe('ISK 5,000');
  });

  it('does not print a hundred times the price where Intl shows no decimals', () => {
    expect(spaced(formatMoney(500000, 'HUF'))).toBe('HUF 5,000');
    expect(spaced(formatMoney(1999900, 'COP'))).toBe('COP 19,999');
  });

  it('keeps decimals the locale would round away', () => {
    expect(spaced(formatMoney(1999950, 'COP'))).toBe('COP 19,999.50');
  });

  it('formats zero and negative amounts', () => {
    expect(formatMoney(0, 'USD')).toBe('$0.00');
    expect(formatMoney(-250, 'USD')).toBe('-$2.50');
  });

  it('follows the locale for symbol and grouping', () => {
    expect(spaced(formatMoney(123456, 'EUR', 'de-DE'))).toBe('1.234,56 €');
    expect(formatMoney(1999, 'usd', 'en-GB')).toBe('US$19.99');
  });

  it('refuses an amount that is not a whole number of minor units', () => {
    for (const amount of [19.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(() => formatMoney(amount, 'USD'), String(amount)).toThrow(RangeError);
      expect(() => formatMoney(amount, 'ABC'), String(amount)).toThrow(RangeError);
    }
  });

  it('writes an unknown code plainly instead of throwing', () => {
    expect(formatMoney(1234, 'ABC')).toBe('12.34 ABC');
    expect(formatMoney(5, 'zz')).toBe('0.05 ZZ');
  });

  it('falls back to a plain number for a locale the runtime rejects', () => {
    expect(formatMoney(1999, 'USD', 'not a locale')).toBe('19.99 USD');
    expect(formatMoney(1500, 'JPY', 'not a locale')).toBe('1500 JPY');
  });
});

describe('percentageDiscount', () => {
  it('rounds toward the buyer in every currency', () => {
    // 15% of 19.99 is 2.9985: the buyer pays 16.99.
    expect(percentageDiscount('USD', 1999, 1500)).toBe(300);
    expect(1999 - percentageDiscount('USD', 1999, 1500)).toBe(1699);
    expect(percentageDiscount('JPY', 1999, 1500)).toBe(300);
    expect(percentageDiscount('INR', 149999, 3333)).toBe(49995);
    expect(percentageDiscount('USD', 50, 100)).toBe(1);
  });

  it('takes exactly the percentage when it divides evenly', () => {
    expect(percentageDiscount('USD', 1000, 1500)).toBe(150);
    expect(percentageDiscount('JPY', 1500, 1500)).toBe(225);
    expect(percentageDiscount('INR', 149900, 5000)).toBe(74950);
    expect(percentageDiscount('USD', 10000, 1)).toBe(1);
    expect(percentageDiscount('USD', 3, 3333)).toBe(1);
    expect(percentageDiscount('HUF', 500000, 1000)).toBe(50000);
    for (let amount = 100; amount <= 200_000; amount += 100) {
      for (const percent of [1, 7, 15, 29, 33, 57, 99]) {
        expect(percentageDiscount('USD', amount, percent * 100), `${percent}% of ${amount}`).toBe((amount / 100) * percent);
      }
    }
  });

  it('is exact at the largest amount a price can have', () => {
    expect(percentageDiscount('USD', MAX_PRICE_AMOUNT, 10000)).toBe(MAX_PRICE_AMOUNT);
    expect(percentageDiscount('USD', MAX_PRICE_AMOUNT, 9999)).toBe(Number((BigInt(MAX_PRICE_AMOUNT) * 9999n + 9999n) / 10000n));
    expect(percentageDiscount('USD', 2_147_480_000, 1500)).toBe(322_122_000);
    expect(percentageDiscount('USD', 2_147_480_001, 1500)).toBe(322_122_001);
    expect(percentageDiscount('HUF', 2_147_483_600, 1)).toBe(214_800);
    for (const amount of [MAX_PRICE_AMOUNT, MAX_PRICE_AMOUNT - 1, 2_000_000_000, 1_999_999_999]) {
      for (const basisPoints of [1, 3, 1499, 1500, 3333, 5000, 9999]) {
        const ceiling = (BigInt(amount) * BigInt(basisPoints) + 9999n) / 10000n;
        expect(percentageDiscount('USD', amount, basisPoints), `${basisPoints}bp of ${amount}`).toBe(Number(ceiling));
      }
    }
  });

  it('rounds up to a whole unit where only whole units can be charged, so what is left is chargeable', () => {
    // 15% of HUF 4,990 is HUF 748.50.
    expect(percentageDiscount('HUF', 499000, 1500)).toBe(74900);
    expect(percentageDiscount('MGA', 499000, 1500)).toBe(74900);
    expect(percentageDiscount('TWD', 33300, 1000)).toBe(3400);
    for (const [currency, amount, basisPoints] of [['HUF', 499000, 1500], ['MGA', 499000, 3333], ['TWD', 33300, 1]] as const) {
      const discount = percentageDiscount(currency, amount, basisPoints);
      expect(discount % 100, currency).toBe(0);
      expect((amount - discount) % 100, currency).toBe(0);
    }
  });

  it('never exceeds the amount and takes nothing for nothing', () => {
    expect(percentageDiscount('USD', 1999, 10000)).toBe(1999);
    expect(percentageDiscount('HUF', 100, 9999)).toBe(100);
    expect(percentageDiscount('USD', 1999, 0)).toBe(0);
    expect(percentageDiscount('USD', 0, 1500)).toBe(0);
  });

  it('names the step', () => {
    expect([chargeableStep('USD'), chargeableStep('JPY'), chargeableStep('HUF'), chargeableStep('twd'), chargeableStep('MGA'), chargeableStep('ZZZ')]).toEqual([1, 1, 100, 100, 100, 1]);
  });
});

describe('localCurrencyOf', () => {
  it('answers for every country in the map', () => {
    for (const [country, currency] of Object.entries(countryCurrency)) {
      expect(localCurrencyOf(country), country).toBe(currency);
    }
  });

  it('ignores case and returns null for what is not a country', () => {
    expect(localCurrencyOf('in')).toBe('INR');
    expect(localCurrencyOf('de')).toBe('EUR');
    expect(localCurrencyOf('ZZ')).toBeNull();
    expect(localCurrencyOf('')).toBeNull();
  });
});
