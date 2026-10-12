/**
 * The words for an Application's billing settings. The settings themselves
 * are read straight off `billingConfig`, which the API always answers
 * complete.
 */

/** What a checkout does when the server names a currency no provider can charge. */
export type UnavailableCurrencyRule = 'fallback' | 'refuse';

/** Each choice with its consequence, as the settings page and the preview form say it. */
export const UNAVAILABLE_CURRENCY: Record<UnavailableCurrencyRule, { label: string; consequence: string }> = {
  fallback: {
    label: 'Charge the default price',
    consequence:
      'The buyer is charged the plan’s default price instead. The checkout page tells them before they pay, and the billing log records it.',
  },
  refuse: {
    label: 'Refuse the checkout',
    consequence:
      'The checkout answers BILLING_NO_PROVIDER_FOR_CURRENCY and nobody is charged. Your server decides what the buyer sees next.',
  },
};
