/**
 * The only provider-specific words on the checkout page outside the payment
 * region. Everything else in the layout (header, summary, disclosures,
 * footer, states) is the same for every provider; a new provider adds one
 * entry here, keyed by `order.client.provider`, and its payment region.
 */

import type { CheckoutPageClient } from '@rekey.dev/shared-types';

export interface CheckoutProviderCopy {
  /** The processor's name, for "processed by" and the fallback link. */
  name: string;
  /** How to pay in the processor's test mode, after "Test mode: no real money moves." */
  testHint: string;
}

const COPY: Record<CheckoutPageClient['provider'], CheckoutProviderCopy> = {
  paypal: { name: 'PayPal', testHint: 'Pay with a PayPal sandbox account.' },
  razorpay: { name: 'Razorpay', testHint: "Pay with Razorpay's test cards or its UPI test flow." },
  stripe: { name: 'Stripe', testHint: 'Use Stripe test card 4242 4242 4242 4242, any future date and any CVC.' },
};

/**
 * @example
 * checkoutProviderCopy('paypal').name; // 'PayPal'
 */
export function checkoutProviderCopy(provider: CheckoutPageClient['provider']): CheckoutProviderCopy {
  return COPY[provider];
}
