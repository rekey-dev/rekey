import type Stripe from 'stripe';

/**
 * The Stripe API version every call from Rekey is made in, and the version
 * webhook endpoints Rekey registers deliver events in.
 *
 * It must equal the version the installed `stripe` SDK is generated for, so
 * the SDK's types describe the responses we actually get back. The
 * `satisfies` clauses fail the typecheck when the SDK is bumped without this.
 *
 * Pinning the endpoint matters as much as pinning the client: an endpoint
 * registered without one, or registered by an older Rekey on
 * `2024-11-20.acacia`, delivers in that older shape until it is
 * re-registered. The webhook translator reads both the acacia and the
 * basil-or-later shapes for that reason.
 */
export const STRIPE_API_VERSION = '2026-09-30.endive' satisfies Stripe.LatestApiVersion &
  Stripe.WebhookEndpointCreateParams.ApiVersion;
