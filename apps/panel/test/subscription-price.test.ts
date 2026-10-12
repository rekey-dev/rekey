/**
 * The price shown for a subscription on the end-user pages.
 *
 * Both pages wrote the plan's default amount and currency, so a subscriber
 * paying the plan's rupee price was shown the dollar one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { subscriptionPriceLabel } from '@/lib/subscription-price';

const euDir = '../src/app/(authed)/applications/[id]/end-users/[euid]';
const source = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`${euDir}/${file}`, import.meta.url)), 'utf8');

describe('subscriptionPriceLabel', () => {
  it("writes the subscription's own price, not the plan's default", () => {
    const subscription = {
      price: { amount: 149900, currency: 'INR' },
      plan: { amount: 1900, currency: 'USD', interval: 'MONTH' },
    };
    expect(subscriptionPriceLabel(subscription)).toBe('₹1,499.00 / month');
  });

  it('says no price is recorded for a subscription with none of its own, never the plan price', () => {
    expect(subscriptionPriceLabel({ price: null, plan: { interval: 'MONTH' } })).toBe('No price recorded');
  });

  it('leaves the interval off a one-off plan', () => {
    expect(subscriptionPriceLabel({ price: { amount: 4900, currency: 'USD' }, plan: { interval: null } })).toBe(
      '$49.00',
    );
  });
});

describe('the end-user pages', () => {
  it('declare the price on every subscription row', () => {
    expect(source('shared.ts')).toMatch(/\n {2}price: \{ amount: number; currency: string \} \| null;/);
  });

  it.each(['page.tsx', 'subscriptions/page.tsx'])('%s never prices a subscription from its plan', (file) => {
    const page = source(file);
    expect(page).toContain('subscriptionPriceLabel(');
    expect(page).not.toMatch(/\.plan\.(amount|currency)\b/);
  });
});
