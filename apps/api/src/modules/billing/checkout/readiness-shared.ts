/**
 * Wording helpers shared by the readiness checks.
 */

import type { CheckoutReadinessCheck } from '@rekey.dev/shared-types';
import type { BillingMode } from '../credentials.service.js';
import { getModule } from '../providers/registry.js';

export type Kind = 'recurring' | 'one_time';

/** @example label('razorpay'); // 'Razorpay' */
export function label(provider: string): string {
  return getModule(provider)?.display.label ?? provider;
}

/** @example modeWord('test'); // 'sandbox' */
export function modeWord(mode: BillingMode): string {
  return mode === 'live' ? 'live' : 'sandbox';
}

/** @example pass('plans', 'paypal', 'All good.').status; // 'PASS' */
export function pass(id: CheckoutReadinessCheck['id'], provider: string | null, message: string): CheckoutReadinessCheck {
  return { id, provider, status: 'PASS', message, fix: null };
}
