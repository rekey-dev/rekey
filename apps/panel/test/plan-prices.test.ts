/**
 * The rules the plan page and its price actions share for a plan's prices in
 * other currencies: what an operator may type, and what the panel says back.
 */

import { describe, expect, it } from 'vitest';
import {
  additionalCurrenciesLabel,
  amountLockReason,
  parsePriceAmount,
  parsePriceCountries,
  parsePriceCurrency,
  planLocalPricesChoices,
  priceAmountPreview,
  priceCountriesLabel,
  removalLockReason,
} from '@/lib/plan-prices';

describe('parsePriceCurrency', () => {
  it('upper-cases and trims a three-letter code', () => {
    expect(parsePriceCurrency(' inr ')).toBe('INR');
  });

  it.each(['', 'IN', 'RUPEE', 'I1R', '₹'])('refuses %j', (raw) => {
    expect(parsePriceCurrency(raw)).toBeNull();
  });
});

describe('parsePriceAmount', () => {
  it('reads an amount typed as the currency is written, as minor units', () => {
    expect(parsePriceAmount(' 1499 ', 'INR')).toBe(149900);
    expect(parsePriceAmount('1499.50', 'INR')).toBe(149950);
  });

  it.each(['', '0', '-5', '14.999', '1e3', 'abc', '99999999999999999999'])('refuses %j', (raw) => {
    expect(parsePriceAmount(raw, 'INR')).toBeNull();
  });
});

describe('parsePriceCountries', () => {
  it('reads codes separated by commas or spaces, upper-cased, once each', () => {
    expect(parsePriceCountries('in, np IN')).toEqual(['IN', 'NP']);
  });

  it('reads an empty field as no countries, which means wherever the currency is local', () => {
    expect(parsePriceCountries('  ')).toEqual([]);
  });

  // Dropping the bad entry would leave [] for "IND", and [] widens the price
  // to every country where the currency is local.
  it.each(['IND', 'IN, IND', 'IN, 1N', 'India'])('refuses the whole field for %j', (raw) => {
    expect(parsePriceCountries(raw)).toBeNull();
  });
});

describe('priceCountriesLabel', () => {
  it('names the rule when no countries are listed', () => {
    expect(priceCountriesLabel({ currency: 'INR', amount: 149900, countries: [] })).toBe(
      'where INR is the local currency',
    );
  });

  it('lists the countries when there are some', () => {
    expect(priceCountriesLabel({ currency: 'EUR', amount: 1900, countries: ['DE', 'FR'] })).toBe('DE, FR');
  });
});

describe('additionalCurrenciesLabel', () => {
  const inr = { currency: 'INR', amount: 149900, countries: [] };
  const eur = { currency: 'EUR', amount: 1900, countries: [] };

  it('says nothing for a plan with only its default price', () => {
    expect(additionalCurrenciesLabel([])).toBeNull();
  });

  it('counts the additional prices', () => {
    expect(additionalCurrenciesLabel([inr])).toBe('+1 currency');
    expect(additionalCurrenciesLabel([eur, inr])).toBe('+2 currencies');
  });
});

describe('priceAmountPreview', () => {
  it('shows the price the typed amount would be saved as', () => {
    expect(priceAmountPreview('1499', 'inr')).toBe('₹1,499.00');
  });

  it('stays quiet until both fields are usable', () => {
    expect(priceAmountPreview('1499', 'IN')).toBeNull();
    expect(priceAmountPreview('', 'INR')).toBeNull();
  });
});

describe('planLocalPricesChoices', () => {
  const choices = planLocalPricesChoices('USD');

  it('offers the three rules the API takes, each with a label and what it does', () => {
    expect(choices.map((choice) => choice.value)).toEqual(['INHERIT', 'TRUSTED', 'OFF']);
    for (const choice of choices) {
      expect(choice.label).not.toBe('');
      expect(choice.consequence.length).toBeGreaterThan(40);
    }
  });

  it('says what OFF charges, in the currency of the default price', () => {
    const off = choices.find((choice) => choice.value === 'OFF')!;
    expect(off.consequence).toContain('charged the default price in USD');
    expect(planLocalPricesChoices('EUR').find((choice) => choice.value === 'OFF')!.consequence).toContain('in EUR');
  });
});

describe('amountLockReason', () => {
  const price = (amountEditable: boolean, status: 'NOT_REQUIRED' | 'PENDING' | 'REGISTERED' | 'FAILED') => ({
    amountEditable,
    registration: { status },
  });

  it('is silent for a price the API says can still be re-priced, whatever its status', () => {
    expect(amountLockReason(price(true, 'NOT_REQUIRED'))).toBeNull();
    expect(amountLockReason(price(true, 'FAILED'))).toBeNull();
  });

  it('follows the API and not the status: a price it says is locked is locked', () => {
    // A provider can hold a price whose status the panel would have read as editable.
    expect(amountLockReason(price(false, 'NOT_REQUIRED'))).toContain('A payment provider holds this price');
    expect(amountLockReason(price(false, 'REGISTERED'))).toContain('archive the plan and create a replacement');
  });

  it('says who is on a price no provider holds, and how to charge a different amount', () => {
    const held = amountLockReason({ ...price(false, 'NOT_REQUIRED'), liveSubscriptions: 2, openCheckouts: 0 });
    expect(held).toContain('A subscriber or an open checkout is on this price');
    expect(held).toContain('remove it and add the new amount');
    const onRecord = amountLockReason({ ...price(false, 'FAILED'), liveSubscriptions: 0, openCheckouts: 0 });
    expect(onRecord).toContain('a payment was recorded at it');
    expect(onRecord).not.toContain('archive the plan');
  });

  it('says a price being registered is only locked until that finishes', () => {
    expect(amountLockReason(price(false, 'PENDING'))).toBe(
      'A payment provider is registering this price now, so its amount cannot change until that finishes.',
    );
  });
});

describe('removalLockReason', () => {
  it('is silent when nobody is on the price', () => {
    expect(removalLockReason({ liveSubscriptions: 0, openCheckouts: 0 })).toBeNull();
  });

  it.each([
    [3, 0, '3 live subscriptions are on this price. It can be removed once they have ended.'],
    [1, 0, '1 live subscription is on this price. It can be removed once it has ended.'],
    [0, 2, '2 open checkouts are on this price. It can be removed once they have completed or expired.'],
    [0, 1, '1 open checkout is on this price. It can be removed once it has completed or expired.'],
    [
      3,
      1,
      '3 live subscriptions and 1 open checkout are on this price. It can be removed once the subscriptions have ended and the checkouts have completed or expired.',
    ],
  ])('counts %d live and %d open as the API would refuse them', (liveSubscriptions, openCheckouts, reason) => {
    expect(removalLockReason({ liveSubscriptions, openCheckouts })).toBe(reason);
  });
});

