/**
 * One mapper for every exception thrown by a payment-provider SDK.
 *
 * Before this existed, each outbound provider call decided for itself what a
 * failure looked like, and most decided nothing at all — the raw SDK error
 * escaped to `rekeyErrorHandler` and got whatever that could infer from it:
 *
 *   POST /api/v1/billing/checkout
 *     → 500 INTERNAL_ERROR ("An unexpected error occurred", share a request id
 *       with support) — for an END USER, about the OPERATOR's Stripe account.
 *
 *   POST /api/v1/tenant/applications/{id}/plans
 *     → 401 { code: "BAD_REQUEST",
 *             message: "Invalid API Key provided: sk_test_************2345",
 *             fix: "Check the request shape against the route schema in /docs." }
 *
 * The second is three separate lies. A `StripeError` carries `.statusCode`
 * (401) and `.message`, which is enough for the `FastifyError` branch in
 * `lib/error.ts` to duck-type it as a framework 4xx: the status passes
 * through, the absent `.code` collapses to `BAD_REQUEST`, and the `fix`
 * blames the caller's request shape — while the actual cause is the
 * operator's own stored credential, and the provider's message (including a
 * fragment of that credential) is echoed verbatim to whoever asked.
 *
 * `POST .../billing-credentials/stripe/register-webhook` already got this
 * right: 502 with a stable code, a framed message, and a `fix` naming
 * credentials. This module generalises that, and adds the one distinction
 * that route did not have to make — WHO IS READING THE RESPONSE.
 *
 *   audience: 'operator'  — the caller owns the credential (every
 *                           /api/v1/tenant/* route). Frame and include the
 *                           provider's message; it is the only thing that
 *                           tells them which key is wrong.
 *   audience: 'end-user'  — the caller is somebody's customer (the public
 *                           /api/v1/billing/* surface). They can do nothing
 *                           about it and must never be shown the operator's
 *                           provider internals, so the message says only that
 *                           the provider refused and who to contact.
 *
 * Status is always 502. The upstream we depend on failed; that is not the
 * caller's fault (4xx) and not a bug in this process (500). Passing the
 * provider's own status through is what produced the mismatched 401.
 */

import { RekeyError } from './error.js';

export { isProviderSdkError } from './dependency-outage.js';

export type ProviderErrorAudience = 'operator' | 'end-user';

/** Stable code for a provider call that failed with no more specific mapping. */
export const PROVIDER_ERROR_CODE = 'BILLING_PROVIDER_ERROR';

const OPERATOR_FIX =
  'Most often the provider credentials are wrong or for the other mode (e.g. live keys with mode=test). ' +
  'Re-check the API key / client secret + mode under the Application’s billing credentials, then retry.';

const END_USER_FIX =
  'Nothing to fix on this end — the payment provider for this application refused the request. ' +
  'Contact the operator of this application, or retry in a few minutes if it was transient.';

/**
 * Cap on how much provider text we quote back.
 *
 * Provider SDKs happily return multi-line bodies with request ids, doc links
 * and stack-ish detail. One sentence is what makes the failure actionable;
 * the rest belongs in the server log.
 */
const MAX_PROVIDER_MESSAGE = 200;

/** Collapse a provider message to one bounded, single-line sentence. */
function summarize(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return 'no detail supplied';
  return oneLine.length > MAX_PROVIDER_MESSAGE
    ? `${oneLine.slice(0, MAX_PROVIDER_MESSAGE - 1)}…`
    : oneLine;
}

export interface ProviderErrorArgs {
  /** 'stripe' | 'razorpay' | 'paypal' — used verbatim in the message. */
  provider: string;
  /** What we were asking the provider to do: 'checkout', 'plan registration', … */
  operation: string;
  audience: ProviderErrorAudience;
  /** The exception the SDK threw. */
  error: unknown;
  /** Override the default `BILLING_PROVIDER_ERROR` (e.g. an established code). */
  code?: string;
  /** Override the default audience-appropriate `fix`. */
  fix?: string;
}

/**
 * Turn a provider-SDK exception into the canonical 502 envelope.
 *
 * A `RekeyError` passes through untouched: `credentialsNotConfigured` (400),
 * `discountUnsupported` (400) and friends are OUR classification of the
 * caller's situation, decided before we ever reached the network, and
 * re-labelling them 502 would be a second lie in the other direction.
 */
export function providerError(args: ProviderErrorArgs): RekeyError {
  if (args.error instanceof RekeyError) return args.error;
  const operatorFacing = args.audience === 'operator';
  return new RekeyError({
    statusCode: 502,
    code: args.code ?? PROVIDER_ERROR_CODE,
    message: operatorFacing
      ? `The ${args.provider} API rejected ${args.operation}: ${summarize(args.error)}`
      : `Payment could not be completed: the ${args.provider} account for this application rejected the request.`,
    fix: args.fix ?? (operatorFacing ? OPERATOR_FIX : END_USER_FIX),
    cause: args.error,
  });
}

/**
 * Run an outbound provider call with the mapping already attached.
 *
 * ```ts
 * const ref = await withProviderErrors(
 *   { provider: 'stripe', operation: 'plan registration', audience: 'operator' },
 *   () => provider.ensurePlanRegistered(plan),
 * );
 * ```
 */
export async function withProviderErrors<T>(
  args: Omit<ProviderErrorArgs, 'error'>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw providerError({ ...args, error: e });
  }
}
