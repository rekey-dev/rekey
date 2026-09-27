import type Stripe from 'stripe';

/**
 * The Stripe API version every call from Rekey is made in, and the version
 * webhook endpoints Rekey registers deliver events in.
 *
 * Pinning the endpoint matters as much as pinning the client: an endpoint
 * registered without one delivers in the account's default version, and from
 * `2025-03-31.basil` that moves `current_period_end` off the subscription onto
 * its items. The webhook translator reads both shapes, so an endpoint
 * registered before the pin still works; re-registering it moves it onto this
 * version.
 */
export const STRIPE_API_VERSION = '2024-11-20.acacia' satisfies Stripe.WebhookEndpointCreateParams.ApiVersion;
