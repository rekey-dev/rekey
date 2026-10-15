/**
 * `selectCheckoutPrice`: which of a plan's prices one checkout is charged at.
 * Pure, so every branch and every refusal is exercised directly.
 */

import { describe, expect, it } from 'vitest';
import {
  selectCheckoutPrice,
  type SelectCheckoutPriceInput,
} from '../src/modules/billing/checkout-price.js';
import { localCurrencyOf, isIsoCurrency, isThreeDecimalCurrency } from '../src/modules/billing/price-currency.js';

const USD = { currency: 'USD', amount: 2000, planPriceId: 'pp_usd', isDefault: true };
const INR = { currency: 'INR', amount: 149900, planPriceId: 'pp_inr' };
const EUR = { currency: 'EUR', amount: 1800, planPriceId: 'pp_eur' };
const GBP = { currency: 'GBP', amount: 1600, planPriceId: 'pp_gbp' };

function select(over: Partial<SelectCheckoutPriceInput> = {}) {
  return selectCheckoutPrice({
    planSlug: 'pro',
    defaultPrice: { id: 'pp_usd', currency: 'USD', amount: 2000, countries: [] },
    prices: [
      { id: 'pp_inr', currency: 'INR', amount: 149900, countries: [] },
      { id: 'pp_eur', currency: 'EUR', amount: 1800, countries: [] },
      { id: 'pp_gbp', currency: 'GBP', amount: 1600, countries: ['GB', 'IE'] },
    ],
    buyer: null,
    requestedCurrency: undefined,
    callerIsSecretKey: true,
    localPrices: 'trusted',
    onUnavailableCurrency: 'fallback',
    boundCurrency: null,
    chargeable: () => true,
    ...over,
  });
}

function refusal(over: Partial<SelectCheckoutPriceInput>) {
  try {
    select(over);
  } catch (e) {
    return e as { code: string; statusCode: number; fix: string; message: string };
  }
  throw new Error('expected a refusal');
}

describe('selectCheckoutPrice', () => {
  describe('the default price', () => {
    it('is charged when nothing else applies', () => {
      expect(select()).toMatchObject(USD);
    });

    it('is charged for a country the table does not cover and no price names', () => {
      expect(select({ buyer: { country: 'ZZ', source: 'declared' } })).toMatchObject(USD);
    });
  });

  describe("the buyer's country", () => {
    it('selects the price in the local currency when the country is declared', () => {
      expect(select({ buyer: { country: 'IN', source: 'declared' } })).toMatchObject(INR);
    });

    it('never selects a local price on a hint under `trusted`', () => {
      expect(select({ buyer: { country: 'IN', source: 'hint' } })).toMatchObject(USD);
      expect(select({ buyer: { country: 'GB', source: 'hint' } })).toMatchObject(USD);
    });

    it('selects a local price on a hint under `any`', () => {
      expect(select({ buyer: { country: 'IN', source: 'hint' }, localPrices: 'any' })).toMatchObject(INR);
      expect(select({ buyer: { country: 'GB', source: 'hint' }, localPrices: 'any' })).toMatchObject(GBP);
    });

    it('prefers a price that names the country over the local-currency one', () => {
      // Ireland uses EUR, and the GBP price names it.
      expect(select({ buyer: { country: 'IE', source: 'declared' } })).toMatchObject(GBP);
    });

    it('does not apply a price with a country list outside that list', () => {
      const prices = [{ id: 'pp_eur', currency: 'EUR', amount: 1800, countries: ['DE'] }];
      expect(select({ prices, buyer: { country: 'FR', source: 'declared' } })).toMatchObject(USD);
      expect(select({ prices, buyer: { country: 'DE', source: 'declared' } })).toMatchObject(EUR);
    });

    it('ignores a stray price in the plan’s own currency', () => {
      const prices = [{ id: 'pp_dup', currency: 'USD', amount: 1, countries: ['US'] }];
      expect(select({ prices, buyer: { country: 'US', source: 'declared' } })).toMatchObject(USD);
    });
  });

  describe('a requested currency', () => {
    it('is honoured from a secret key, over the country', () => {
      expect(select({ requestedCurrency: 'eur', buyer: { country: 'IN', source: 'declared' } })).toMatchObject(EUR);
    });

    it('is REJECTED from a publishable key, never ignored', () => {
      const err = refusal({ requestedCurrency: 'INR', callerIsSecretKey: false });
      expect(err).toMatchObject({ statusCode: 400, code: 'BILLING_CURRENCY_NOT_ALLOWED' });
      expect(err.fix).toContain('secret key');
    });

    it('is rejected from a publishable key even when it is the default, or the bound, currency', () => {
      expect(refusal({ requestedCurrency: 'USD', callerIsSecretKey: false }).code).toBe('BILLING_CURRENCY_NOT_ALLOWED');
      expect(refusal({ requestedCurrency: 'INR', callerIsSecretKey: false, boundCurrency: 'INR' }).code).toBe(
        'BILLING_CURRENCY_NOT_ALLOWED',
      );
    });

    it('is refused when the plan has no price in it, naming the currencies it has', () => {
      const err = refusal({ requestedCurrency: 'JPY' });
      expect(err).toMatchObject({ statusCode: 400, code: 'BILLING_PLAN_CURRENCY_UNAVAILABLE' });
      expect(err.message).toContain('JPY');
      expect(err.fix).toContain('USD, EUR, GBP, INR');
    });
  });

  describe('the currency the buyer is bound to', () => {
    it('wins over the country', () => {
      expect(select({ boundCurrency: 'inr', buyer: { country: 'DE', source: 'declared' } })).toMatchObject(INR);
      expect(select({ boundCurrency: 'INR', requestedCurrency: 'inr' })).toMatchObject(INR);
    });

    it('refuses a requested currency that is not the one the buyer already pays in, instead of swapping it', () => {
      const err = refusal({ boundCurrency: 'INR', requestedCurrency: 'EUR' });
      expect(err).toMatchObject({ statusCode: 409, code: 'BILLING_CURRENCY_CONFLICT' });
      expect(err.message).toContain('INR');
      expect(err.fix).toContain('pass INR');
      // A bound currency the plan is not priced in binds nothing.
      expect(select({ boundCurrency: 'JPY', requestedCurrency: 'EUR' })).toMatchObject(EUR);
    });

    it('is skipped when the plan has no price in it', () => {
      expect(select({ boundCurrency: 'JPY', buyer: { country: 'IN', source: 'declared' } })).toMatchObject(INR);
      expect(select({ boundCurrency: 'JPY' })).toMatchObject(USD);
    });
  });

  describe('the reason', () => {
    it('says why each price was selected', () => {
      expect(select().reason).toBe('default');
      expect(select({ buyer: { country: 'IN', source: 'hint' } }).reason).toBe('default');
      expect(select({ buyer: { country: 'IN', source: 'declared' } }).reason).toBe('country');
      expect(select({ requestedCurrency: 'EUR' }).reason).toBe('requested');
      expect(select({ boundCurrency: 'INR', buyer: { country: 'DE', source: 'declared' } }).reason).toBe('bound');
      expect(select({ boundCurrency: 'USD', buyer: { country: 'IN', source: 'declared' } }).reason).toBe('bound');
    });

    it('says fallback when the price selected cannot be charged and the default is charged instead', () => {
      const chargeable = (currency: string) => currency === 'USD';
      expect(select({ buyer: { country: 'IN', source: 'declared' }, chargeable })).toEqual({
        ...USD,
        reason: 'fallback',
        fallback: {
          requested: { planPriceId: 'pp_inr', currency: 'INR', amount: 149900, isDefault: false },
          requestedBecause: 'country',
          reason: 'no_provider_for_currency',
        },
      });
    });
  });

  describe('a currency no provider can charge', () => {
    it('falls back to the default price', () => {
      const chargeable = (currency: string) => currency === 'USD';
      expect(select({ buyer: { country: 'IN', source: 'declared' }, chargeable })).toMatchObject(USD);
    });

    it('never moves a buyer off the currency they already pay in: the checkout is refused', () => {
      const chargeable = (currency: string) => currency === 'USD';
      const err = refusal({ boundCurrency: 'INR', chargeable });
      expect(err).toMatchObject({ statusCode: 409, code: 'BILLING_CURRENCY_CONFLICT' });
      expect(err.message).toContain('INR');
      expect(err.fix).toContain("Add INR to a provider's currencies");
      expect(err.fix).toContain('cancel their subscription');
      const named = refusal({ boundCurrency: 'INR', chargeable, onlyProvider: 'razorpay' });
      expect(named.message).toContain('"razorpay"');
      expect(named.fix).toContain('Add INR to the currencies of "razorpay"');
    });

    it('charges the default price for a currency the server named and nobody can charge, and says so', () => {
      const chargeable = (currency: string) => currency === 'USD';
      expect(select({ requestedCurrency: 'EUR', chargeable })).toEqual({
        ...USD,
        reason: 'fallback',
        fallback: {
          requested: { planPriceId: 'pp_eur', currency: 'EUR', amount: 1800, isDefault: false },
          requestedBecause: 'requested',
          reason: 'no_provider_for_currency',
        },
      });
    });

    it('refuses that currency instead when the server asked to be refused', () => {
      const chargeable = (currency: string) => currency === 'USD';
      const err = refusal({ requestedCurrency: 'EUR', chargeable, onUnavailableCurrency: 'refuse' });
      expect(err).toMatchObject({ statusCode: 400, code: 'BILLING_NO_PROVIDER_FOR_CURRENCY' });
      expect(err.message).toContain('EUR');
      expect(err.fix).toContain('"fallback"');
    });

    it('never selects a local price when the plan has local prices off, whoever vouches for the country', () => {
      for (const source of ['declared', 'vouched', 'hint'] as const) {
        expect(select({ buyer: { country: 'IN', source }, localPrices: 'off' })).toMatchObject({ ...USD, reason: 'default' });
      }
      expect(select({ requestedCurrency: 'INR', localPrices: 'off' })).toMatchObject(INR);
    });

    it('never asks whether the default price can be charged: the provider pick owns that refusal', () => {
      const asked: string[] = [];
      const chargeable = (currency: string) => {
        asked.push(currency);
        return false;
      };
      expect(select({ chargeable })).toMatchObject({ ...USD, reason: 'default' });
      expect(select({ requestedCurrency: 'USD', chargeable })).toMatchObject({ ...USD, reason: 'requested' });
      expect(select({ boundCurrency: 'USD', chargeable })).toMatchObject({ ...USD, reason: 'bound' });
      expect(select({ buyer: { country: 'IN', source: 'declared' }, chargeable })).toMatchObject({ ...USD, reason: 'fallback' });
      expect(asked).toEqual(['INR']);
    });
  });
});

describe('the currency tables', () => {
  it('map a country to its local currency', () => {
    expect([localCurrencyOf('IN'), localCurrencyOf('US'), localCurrencyOf('GB')]).toEqual(['INR', 'USD', 'GBP']);
    expect([localCurrencyOf('JP'), localCurrencyOf('AU'), localCurrencyOf('CA')]).toEqual(['JPY', 'AUD', 'CAD']);
    for (const country of ['DE', 'FR', 'IT', 'ES', 'NL', 'IE', 'PT', 'AT', 'BE', 'FI', 'GR', 'HR']) {
      expect(localCurrencyOf(country), country).toBe('EUR');
    }
    expect(localCurrencyOf('fr')).toBe('EUR');
    // Not in the eurozone, and a EUR price must not reach them by default.
    expect(localCurrencyOf('PL')).toBe('PLN');
    expect(localCurrencyOf('CH')).toBe('CHF');
    expect(localCurrencyOf('ZZ')).toBeNull();
  });

  it('know an ISO 4217 code and a three-decimal currency', () => {
    expect(isIsoCurrency('INR')).toBe(true);
    expect(isIsoCurrency('XYZ')).toBe(false);
    expect(isIsoCurrency('inr')).toBe(false);
    expect(['KWD', 'BHD', 'OMR', 'JOD', 'TND'].every(isThreeDecimalCurrency)).toBe(true);
    expect(isThreeDecimalCurrency('JPY')).toBe(false);
  });
});
