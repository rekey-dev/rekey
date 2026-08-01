/**
 * The one refusal for "this provider cannot apply this discount".
 *
 * Lives in its own leaf module rather than next to the checkout policy in
 * `billing/checkout-discount.ts`: the provider classes need it too, and that
 * file imports the registry, which imports the modules, which import the
 * provider classes. A leaf keeps the wording in one place without the cycle.
 */

import { RekeyError } from '../../../lib/error.js';

/** Which checkout surface was asked for the discount. */
export type CheckoutFlow = 'recurring' | 'one-time';

/**
 * Refuse a coupon the provider genuinely cannot honour.
 *
 * A 400, not a 500: nothing is broken, the buyer has simply picked a
 * combination this Application cannot sell. The `fix` names both ways out —
 * drop the coupon, or route the checkout at a provider that supports it
 * (`POST /billing/checkout` takes an explicit `provider`).
 */
export function discountUnsupported(provider: string, flow: CheckoutFlow): RekeyError {
  const surface = flow === 'recurring' ? 'a recurring subscription' : 'a one-time purchase';
  return new RekeyError({
    statusCode: 400,
    code: 'BILLING_DISCOUNT_UNSUPPORTED',
    message: `Billing provider "${provider}" cannot apply a coupon discount to ${surface}.`,
    fix:
      'Retry the checkout without `couponCode`, or pass `provider` naming one that supports ' +
      'discounts on this flow (see `discounts` in GET /api/v1/billing/providers). The coupon ' +
      'was NOT redeemed.',
  });
}
