/**
 * What an end-user's existing subscription means for a grant of the same plan.
 */

import { describe, expect, it } from 'vitest';
import { grantCurrencyControl, grantRestriction, type GrantRestriction } from '@/lib/grant-currencies';

describe('grantRestriction', () => {
  it('holds a subscriber to the currency their live subscription is in', () => {
    const restriction = grantRestriction([{ planSlug: 'pro', status: 'ACTIVE', currency: 'inr' }], 'pro');
    expect(restriction).toMatchObject({ kind: 'held', currency: 'INR' });
  });

  it('binds no currency for a live subscription with no price of its own', () => {
    expect(grantRestriction([{ planSlug: 'pro', status: 'ACTIVE', currency: null }], 'pro')).toEqual({ kind: 'none' });
  });

  it('refuses a named currency while a checkout for the plan is unpaid', () => {
    expect(grantRestriction([{ planSlug: 'pro', status: 'PENDING', currency: null }], 'pro').kind).toBe('unsettled');
  });

  it('ignores other plans and ended subscriptions', () => {
    expect(grantRestriction([{ planSlug: 'team', status: 'ACTIVE', currency: 'USD' }], 'pro')).toEqual({ kind: 'none' });
    expect(grantRestriction([{ planSlug: 'pro', status: 'CANCELED', currency: 'USD' }], 'pro')).toEqual({ kind: 'none' });
  });
});

describe('grantCurrencyControl', () => {
  const USD = { currency: 'USD', price: '$19.00' };
  const INR = { currency: 'INR', price: '₹1,499.00' };
  const EUR = { currency: 'EUR', price: '€17.00' };
  const prices = [USD, INR, EUR];
  const heldIn = (currency: string): GrantRestriction => grantRestriction([{ planSlug: 'pro', status: 'ACTIVE', currency }], 'pro');
  const open = (control: ReturnType<typeof grantCurrencyControl>) => control.choices.filter((choice) => !choice.disabled).map((choice) => choice.value);

  it('offers the plan default and every currency when nothing is held', () => {
    const control = grantCurrencyControl(prices, { kind: 'none' }, 'INR');
    expect(open(control)).toEqual(['', 'USD', 'INR', 'EUR']);
    expect(control.value).toBe('INR');
    expect(control.choices[0]!.label).toBe('Plan default (USD, $19.00)');
    expect(grantCurrencyControl(prices, { kind: 'none' }, 'GBP').value).toBe('');
  });

  it('switches off every other currency, and the plan default when it is another currency, for a subscription held in a currency', () => {
    const control = grantCurrencyControl(prices, heldIn('INR'), '');
    expect(open(control)).toEqual(['INR']);
    // The select cannot rest on a switched-off choice, whatever was chosen before the plan was picked.
    expect(control.value).toBe('INR');
    expect(grantCurrencyControl(prices, heldIn('INR'), 'EUR').value).toBe('INR');
  });

  it('leaves the plan default on when the subscription is held in the default currency', () => {
    const control = grantCurrencyControl(prices, heldIn('usd'), '');
    expect(open(control)).toEqual(['', 'USD']);
    expect(control.value).toBe('');
    expect(grantCurrencyControl(prices, heldIn('USD'), 'USD').value).toBe('USD');
    expect(grantCurrencyControl(prices, heldIn('USD'), 'INR').value).toBe('USD');
  });

  it('can only confirm the subscription as it stands when the plan no longer sells in its currency', () => {
    const control = grantCurrencyControl(prices, heldIn('GBP'), 'USD');
    expect(open(control)).toEqual(['']);
    expect(control.value).toBe('');
    expect(control.choices[0]!.label).toBe('Keep GBP: the plan no longer sells in it');
  });

  it('offers every currency for a live subscription with no price of its own', () => {
    const none = grantRestriction([{ planSlug: 'pro', status: 'ACTIVE', currency: null }], 'pro');
    expect(open(grantCurrencyControl(prices, none, ''))).toEqual(['', 'USD', 'INR', 'EUR']);
  });

  it('keeps only the plan default while a checkout for the plan is unpaid', () => {
    const unsettled = grantRestriction([{ planSlug: 'pro', status: 'PENDING', currency: null }], 'pro');
    const control = grantCurrencyControl(prices, unsettled, 'INR');
    expect(open(control)).toEqual(['']);
    expect(control.value).toBe('');
  });

  it('says why on the control', () => {
    const restriction = heldIn('INR');
    expect(restriction.kind === 'held' && restriction.reason).toContain('the other currencies are switched off');
  });
});
