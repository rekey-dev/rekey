/**
 * Money in and out of the panel, against literal strings and integers.
 *
 * The API stores every amount at the ISO 4217 exponent. `Intl` shows the
 * forint, the Colombian peso, the rupiah, the Pakistani rupee and the ariary
 * with no decimals, and a formatter that divides by what `Intl` shows prints
 * a hundred times what was charged.
 */

import { describe, expect, it } from 'vitest';
import { formatMoney } from '@/lib/format';
import { majorToMinor, readTypedPlanAmount, readTypedPrice } from '@/lib/money-input';
import { parsePriceAmount, priceAmountPreview } from '@/lib/plan-prices';

// Intl puts a no-break space between a currency code and the number.
const NBSP = ' ';

describe('formatMoney, stored minor units to a price', () => {
  it.each([
    ['USD', 1999, '$19.99'],
    ['JPY', 1500, '¥1,500'],
    ['HUF', 500000, `HUF${NBSP}5,000`],
    ['COP', 500000, `COP${NBSP}5,000`],
    ['IDR', 15000000, `IDR${NBSP}150,000`],
    ['PKR', 250000, `PKR${NBSP}2,500`],
    ['MGA', 500000, `MGA${NBSP}5,000`],
    ['KRW', 5000, '₩5,000'],
    ['INR', 149900, '₹1,499.00'],
    ['EUR', 1999, '€19.99'],
  ])('%s %i reads %s', (currency, minor, shown) => {
    expect(formatMoney(minor, currency)).toBe(shown);
  });

  it('keeps the decimals Intl would hide when dropping them would round the amount', () => {
    expect(formatMoney(500050, 'COP')).toBe(`COP${NBSP}5,000.50`);
  });

  it('refuses an amount that is not a whole number instead of printing a wrong price', () => {
    expect(() => formatMoney(19.99, 'USD')).toThrow(RangeError);
    expect(() => formatMoney(Number.NaN, 'USD')).toThrow(RangeError);
  });
});

describe('a typed amount, to the minor units that are sent', () => {
  it.each([
    ['USD', '19.99', 1999],
    ['JPY', '1500', 1500],
    ['HUF', '5000', 500000],
    ['COP', '5000', 500000],
    ['IDR', '150000', 15000000],
    ['PKR', '2500', 250000],
    ['MGA', '5000', 500000],
    ['KRW', '5000', 5000],
    ['INR', '1499', 149900],
    ['EUR', '19.9', 1990],
  ])('%s %j sends %i', (currency, typed, minor) => {
    expect(readTypedPrice(typed, currency)).toEqual({ ok: true, minor });
    expect(parsePriceAmount(typed, currency)).toBe(minor);
  });

  it('shifts digits as text, where 19.99 times 100 in floating point is not 1999', () => {
    expect(majorToMinor('19.99', 'USD')).toBe(1999);
    expect(majorToMinor('4.35', 'USD')).toBe(435);
    expect(majorToMinor('1.15', 'EUR')).toBe(115);
  });

  it.each([
    ['JPY', '19.99', 'JPY has no decimals, so type a whole number.'],
    ['KRW', '0.5', 'KRW has no decimals, so type a whole number.'],
    ['USD', '19.999', 'USD has 2 decimals at most.'],
    ['HUF', '5000.50', 'HUF is priced in whole units, so type a whole number.'],
    ['MGA', '0.20', 'MGA is priced in whole units, so type a whole number.'],
    ['USD', '0', 'A price is greater than zero.'],
    ['USD', '-5', 'Type the amount as a plain number, such as 19.99.'],
    ['USD', '1e3', 'Type the amount as a plain number, such as 19.99.'],
    ['USD', '1,499', 'Type the amount as a plain number, such as 19.99.'],
    ['ABC', '5', 'ABC is not a currency Rekey knows.'],
    ['KWD', '1.234', 'KWD is not a currency a price can be in.'],
  ])('%s %j is refused', (currency, typed, message) => {
    expect(readTypedPrice(typed, currency)).toEqual({ ok: false, message });
    expect(parsePriceAmount(typed, currency)).toBeNull();
  });

  it('refuses an amount above what the API stores', () => {
    expect(readTypedPrice('21474836.47', 'USD')).toEqual({ ok: true, minor: 2147483647 });
    expect(readTypedPrice('21474836.48', 'USD').ok).toBe(false);
    expect(readTypedPrice('99999999999999999999', 'JPY').ok).toBe(false);
  });

  it('lets a plan itself cost nothing, in a currency a price can be in', () => {
    expect(readTypedPlanAmount('0', 'USD')).toEqual({ ok: true, minor: 0 });
    expect(readTypedPlanAmount('0.00', 'USD')).toEqual({ ok: true, minor: 0 });
    expect(readTypedPlanAmount('9.99', 'USD')).toEqual({ ok: true, minor: 999 });
    expect(readTypedPlanAmount('0', 'KWD').ok).toBe(false);
    expect(readTypedPlanAmount('19.99', 'JPY').ok).toBe(false);
  });
});

describe('the add-price preview', () => {
  it.each([
    ['USD', '19.99', '$19.99'],
    ['JPY', '1500', '¥1,500'],
    ['HUF', '5000', `HUF${NBSP}5,000`],
    ['COP', '5000', `COP${NBSP}5,000`],
    ['IDR', '150000', `IDR${NBSP}150,000`],
    ['PKR', '2500', `PKR${NBSP}2,500`],
    ['MGA', '5000', `MGA${NBSP}5,000`],
    ['KRW', '5000', '₩5,000'],
    ['INR', '1499', '₹1,499.00'],
    ['EUR', '19.9', '€19.90'],
  ])('%s %j previews as %s', (currency, typed, shown) => {
    expect(priceAmountPreview(typed, currency)).toBe(shown);
  });

  it('says why an amount cannot be saved instead of showing a price', () => {
    expect(priceAmountPreview('19.99', 'JPY')).toBe('JPY has no decimals, so type a whole number.');
    expect(priceAmountPreview('5000.50', 'huf')).toBe('HUF is priced in whole units, so type a whole number.');
  });

  it('stays quiet until both fields have something in them', () => {
    expect(priceAmountPreview('1499', 'IN')).toBeNull();
    expect(priceAmountPreview('', 'INR')).toBeNull();
  });
});
