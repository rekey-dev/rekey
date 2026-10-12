/**
 * The readiness warning for a provider with no currency: its list is empty,
 * so no checkout is ever routed to it.
 */

import type { CheckoutReadinessCheck } from '@rekey.dev/shared-types';
import { label } from './readiness-shared.js';

/**
 * @example
 * noCurrencyCheck('stripe').message; // 'Stripe has no currency ticked, so it is not used for any checkout.'
 */
export function noCurrencyCheck(provider: string): CheckoutReadinessCheck {
  return {
    id: 'provider',
    provider,
    status: 'WARN',
    message: `${label(provider)} has no currency ticked, so it is not used for any checkout.`,
    fix: `Tick the currencies this account charges in Panel → Application → Billing → Setup → Providers → ${label(provider)} → Edit, or disable ${label(provider)} there.`,
  };
}
