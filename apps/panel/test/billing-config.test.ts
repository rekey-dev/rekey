/**
 * The API answers with every money setting on `billingConfig`, whatever was
 * stored, so the panel reads them straight off it. And the panel has words
 * for each choice of the unavailable-currency rule.
 */

import { describe, expect, it } from 'vitest';
import { BillingConfigSchema } from '@rekey.dev/shared-types';
import type { ApplicationRow } from '@/lib/api';
import { UNAVAILABLE_CURRENCY } from '@/lib/billing-config';

describe('a billing config stored before the money settings existed', () => {
  it('is answered with all three, so the panel type can require them', () => {
    const answered = BillingConfigSchema.parse({ enabled: true, provider: 'stripe' });
    const read: Pick<ApplicationRow['billingConfig'], 'localPrices' | 'reportingCurrency' | 'onUnavailableCurrency'> = answered;
    expect(read).toMatchObject({ localPrices: 'trusted', reportingCurrency: 'USD', onUnavailableCurrency: 'fallback' });
  });
});

describe('the rule for a named currency nobody can charge', () => {
  it('has words for both choices, each with its consequence', () => {
    expect(Object.keys(UNAVAILABLE_CURRENCY).sort()).toEqual(BillingConfigSchema.shape.onUnavailableCurrency.removeDefault().options.slice().sort());
    for (const choice of ['fallback', 'refuse'] as const) {
      expect(UNAVAILABLE_CURRENCY[choice].label.length).toBeGreaterThan(5);
      expect(UNAVAILABLE_CURRENCY[choice].consequence.length).toBeGreaterThan(20);
    }
  });
});
