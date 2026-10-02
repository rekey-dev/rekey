import { stripeKeyMode } from '../providers/stripe-key-mode.js';

const STRIPE_EDIT = 'Panel → Application → Billing → Setup → Providers → Stripe → Edit';

/**
 * Why the Stripe payment form cannot load with these credentials, or null
 * when it can: the publishable key is missing, malformed, or in the other
 * mode from the secret key (its sessions would be invisible to it).
 *
 * @example
 * stripePublishableKeyFailure({ apiKey: 'sk_live_…', publishableKey: 'pk_test_…' }); // { message, fix }
 */
export function stripePublishableKeyFailure(data: Record<string, unknown>): { message: string; fix: string } | null {
  const publishable = typeof data.publishableKey === 'string' ? data.publishableKey : '';
  const secretMode = stripeKeyMode(typeof data.apiKey === 'string' ? data.apiKey : undefined);
  const publishableMode = stripeKeyMode(publishable);
  if (publishable === '' || publishableMode === null) {
    return {
      message: "The Stripe publishable key is missing. It is a public value the checkout page's payment form loads with.",
      fix: `Enter the publishable key (pk_${secretMode ?? 'test'}_…) in ${STRIPE_EDIT}.`,
    };
  }
  if (secretMode !== null && publishableMode !== secretMode) {
    return {
      message: `The Stripe publishable key is a ${publishableMode} key and the secret key is a ${secretMode} key, so the payment form would not find this checkout.`,
      fix: `Replace it with the ${secretMode} publishable key (pk_${secretMode}_…) in ${STRIPE_EDIT}.`,
    };
  }
  return null;
}
