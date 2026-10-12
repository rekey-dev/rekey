/**
 * The plan form's Amount hint: one thing at a time, and the price it shows is
 * the one the typed amount would be saved as.
 */

import { describe, expect, it } from 'vitest';
import { amountHint } from '@/lib/plan-amount-hint';

describe('plan amount hint', () => {
  it('shows only the example while the field is empty', () => {
    expect(amountHint('SUBSCRIPTION', '', 'USD')).toEqual({
      example: 'As the currency is written, such as 9.99.',
      live: null,
    });
    expect(amountHint('USAGE', '', 'USD')).toEqual({ example: '0 = pure pay-as-you-go.', live: null });
    expect(amountHint('CREDIT', '', 'USD').example).toBe('One-time charge for the pack, such as 49.99.');
  });

  it('shows only the price once there is one', () => {
    for (const kind of ['SUBSCRIPTION', 'LICENSE', 'USAGE', 'CREDIT'] as const) {
      expect(amountHint(kind, '19.99', 'USD')).toEqual({ example: null, live: '$19.99' });
    }
  });

  it('prices the amount in the currency typed beside it', () => {
    expect(amountHint('SUBSCRIPTION', '1500', 'JPY').live).toBe('¥1,500');
    expect(amountHint('SUBSCRIPTION', '5000', 'HUF').live).toBe('HUF 5,000');
    expect(amountHint('SUBSCRIPTION', '1499', 'inr').live).toBe('₹1,499.00');
  });

  it('says why an amount cannot be saved', () => {
    expect(amountHint('SUBSCRIPTION', '19.99', 'JPY')).toEqual({
      example: null,
      live: 'JPY has no decimals, so type a whole number.',
    });
    expect(amountHint('SUBSCRIPTION', '-5', 'USD').live).toBe('Type the amount as a plain number, such as 19.99.');
  });

  it('keeps the example for zero, an empty field or a half-typed currency', () => {
    expect(amountHint('USAGE', '0', 'USD')).toEqual({ example: '0 = pure pay-as-you-go.', live: null });
    expect(amountHint('SUBSCRIPTION', '   ', 'USD').live).toBeNull();
    expect(amountHint('SUBSCRIPTION', '19.99', 'US').live).toBeNull();
  });
});
