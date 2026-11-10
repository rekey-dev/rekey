/**
 * What the plan list offers for one plan: buy it, nothing because it is the
 * buyer's own, or a plain reason it cannot be bought.
 */

/** The part of a catalogue plan this decision reads. */
export interface OfferedPlan {
  isFree: boolean;
  checkout: { ready: boolean };
}

export type PlanOffer =
  | { kind: 'current' }
  | { kind: 'buy' }
  | { kind: 'unavailable'; reason: string }
  /** Nothing to press: the buyer may only look, or the plan applies without a checkout. */
  | { kind: 'none' };

export const UNAVAILABLE_REASON = 'Not available to buy right now.';

/**
 * @example
 * planOffer({ isFree: false, checkout: { ready: false } }, { held: false, canCheckout: true });
 * // { kind: 'unavailable', reason: 'Not available to buy right now.' }
 */
export function planOffer(plan: OfferedPlan, buyer: { held: boolean; canCheckout: boolean }): PlanOffer {
  const sellable = plan.checkout.ready;
  // Never hidden for the subscriber who is on it, and never called unbuyable:
  // they already have it, so whether checkout could sell it again is noise.
  if (buyer.held) return { kind: 'current' };
  // `checkout.ready` describes checkout only. A free plan can read false and
  // still apply to every signed-in user, so it is not called unavailable.
  if (!sellable) return plan.isFree ? { kind: 'none' } : { kind: 'unavailable', reason: UNAVAILABLE_REASON };
  return buyer.canCheckout ? { kind: 'buy' } : { kind: 'none' };
}
