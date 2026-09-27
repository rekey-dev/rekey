/**
 * The plan form's Amount hint showed its static example and the live preview
 * together, so typing 1999 read "999 = $9.99 = $19.99".
 */

import { describe, expect, it } from 'vitest';
import { amountHint } from '@/components/PlanCreateForm';

describe('plan amount hint', () => {
  it('shows only the example while the field is empty', () => {
    expect(amountHint('SUBSCRIPTION', '')).toEqual({ example: '999 = $9.99', live: null });
    expect(amountHint('USAGE', '')).toEqual({ example: '0 = pure pay-as-you-go.', live: null });
    expect(amountHint('CREDIT', '').example).toContain('4999 = $49.99');
  });

  it('shows only the typed value once there is one', () => {
    for (const kind of ['SUBSCRIPTION', 'LICENSE', 'USAGE', 'CREDIT'] as const) {
      expect(amountHint(kind, '1999')).toEqual({ example: null, live: '1999 = $19.99' });
    }
  });

  it('keeps the example for zero or garbage input', () => {
    expect(amountHint('USAGE', '0')).toEqual({ example: '0 = pure pay-as-you-go.', live: null });
    expect(amountHint('SUBSCRIPTION', '-5').live).toBeNull();
    expect(amountHint('SUBSCRIPTION', '   ').example).toBe('999 = $9.99');
  });
});
