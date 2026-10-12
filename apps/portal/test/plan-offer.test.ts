/**
 * What the plan list offers for a plan, and the sentences that warn a buyer
 * the price is not the one for their currency.
 */

import { describe, expect, it } from 'vitest';
import { HELD_UNAVAILABLE_NOTE, planOffer, UNAVAILABLE_REASON } from '@/lib/plan-offer';
import { catalogueFallbackSentence, priceFallbackSentence } from '@/lib/price-notice';
import { CHECKOUT_WITH_FALLBACK, PLANS } from './fixtures/billing';

describe('planOffer', () => {
  const buyer = { held: false, canCheckout: true };

  it('offers a plan whose checkout is ready', () => {
    expect(planOffer(PLANS.proDefault, buyer)).toEqual({ kind: 'buy' });
  });

  it('shows a plan that cannot be bought as unavailable, with a reason', () => {
    expect(planOffer({ isFree: false, checkout: { ready: false } }, buyer)).toEqual({
      kind: 'unavailable',
      reason: UNAVAILABLE_REASON,
    });
  });

  it('keeps showing a subscriber the plan they are on, and says when it cannot be bought again', () => {
    expect(planOffer(PLANS.proDefault, { held: true, canCheckout: true })).toEqual({ kind: 'current', note: null });
    expect(planOffer(PLANS.proBoundUnchargeable, { held: true, canCheckout: true })).toEqual({
      kind: 'current',
      note: HELD_UNAVAILABLE_NOTE,
    });
  });

  it('never calls a free plan unavailable: it applies without a checkout', () => {
    expect(planOffer(PLANS.free, buyer)).toEqual({ kind: 'none' });
    expect(planOffer(PLANS.free, { held: true, canCheckout: true })).toEqual({ kind: 'current', note: null });
  });

  it('offers nothing to a team member who may only look', () => {
    expect(planOffer(PLANS.proDefault, { held: false, canCheckout: false })).toEqual({ kind: 'none' });
  });
});

describe('price fallback sentences', () => {
  it('names the currency that is not available and the amount and currency charged', () => {
    expect(priceFallbackSentence(CHECKOUT_WITH_FALLBACK.priceFallback!)).toBe(
      'Prices in INR are not available yet. You will pay $19.00 (USD).',
    );
  });

  it('speaks from the catalogue only when its price is a fallback', () => {
    expect(catalogueFallbackSentence(PLANS.proFallback.price)).toBe(
      'A price in INR is not available yet. You will pay $19.00 (USD).',
    );
    expect(catalogueFallbackSentence(PLANS.proDefault.price)).toBeNull();
    expect(catalogueFallbackSentence(PLANS.proInIndia.price)).toBeNull();
    expect(catalogueFallbackSentence(null)).toBeNull();
  });
});
