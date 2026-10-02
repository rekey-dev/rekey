import Stripe from 'stripe';
import { STRIPE_API_VERSION } from './stripe-api-version.js';

/**
 * Hard ceiling on any Stripe API call. The SDK default is 80 seconds, and
 * every call Rekey makes has an operator, an end-user or a provider's webhook
 * delivery waiting on it. 10s matches the PayPal and Razorpay providers.
 */
const STRIPE_TIMEOUT_MS = 10_000;

/**
 * A Stripe client for one Application's own secret key, pinned to
 * `STRIPE_API_VERSION`.
 *
 * One retry, which the SDK applies only to requests it knows are safe to
 * repeat (it sends an idempotency key on writes).
 *
 * @example
 * const stripe = createStripeClient(creds.apiKey);
 * await stripe.invoicePayments.list({ invoice: 'in_123' });
 */
export function createStripeClient(apiKey: string): Stripe {
  return new Stripe(apiKey, {
    apiVersion: STRIPE_API_VERSION,
    timeout: STRIPE_TIMEOUT_MS,
    maxNetworkRetries: 1,
  });
}
