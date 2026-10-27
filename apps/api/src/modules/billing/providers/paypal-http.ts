/**
 * PayPal REST plumbing shared by the provider, its Orders v2 calls and the
 * webhook verification: the per-mode API bases, request deadlines, and how a
 * PayPal refusal becomes an answer the caller can act on.
 */

import { RekeyError } from '../../../lib/error.js';

export const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
export const LIVE_BASE = 'https://api-m.paypal.com';

/**
 * Hard ceiling on any outbound PayPal call.
 *
 * Node's undici has NO default request timeout, so a bare `fetch()` to a
 * wedged host hangs until the OS gives up on the socket, minutes, or never.
 * Every PayPal call used to be a bare `fetch()`.
 *
 * 10s matches the outbound budget the OAuth providers and the webhook
 * dispatcher already use. These are operator-initiated management calls
 * (register a plan, create a checkout, cancel a subscription) where the caller
 * is a human waiting on an HTTP response.
 */
export const PAYPAL_TIMEOUT_MS = 10_000;

/**
 * Tighter ceiling for the calls on the INBOUND WEBHOOK request path
 * (`verifyPaypalWebhook`: a token mint plus the verify POST, so the worst case
 * is 2× this).
 *
 * That path is the sharp one. It runs synchronously inside the Fastify handler
 * for every webhook PayPal sends; with no timeout at all, a wedged
 * api-m.paypal.com held a handler open indefinitely, PayPal retried and opened
 * another, and the process ran out of connections while `/health/live`, which
 * touches neither PayPal nor the handler pool, stayed green. Failing a
 * webhook fast costs one provider retry; holding it costs the API.
 */
export const PAYPAL_WEBHOOK_TIMEOUT_MS = 4_000;

/**
 * `fetch` with a deadline. The signal stays armed after the response
 * resolves, so it covers the body read too, a server that returns headers
 * promptly and then trickles the body still hits the deadline.
 */
export function paypalFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = PAYPAL_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Why the online verification is still on the request path.
 *
 * PayPal's signature check IS the authentication for the webhook route (there
 * is no bearer token; see pipeline.ts). Deferring it means either acting on an
 * unverified payload, or persisting one to a quarantine and building a second
 * pipeline to drain it, a new trust boundary and a new failure mode to buy
 * latency we do not otherwise have a problem with. The timeout above bounds
 * the damage, and an unreachable PayPal now answers 503 rather than 401 (see
 * `PaypalVerifyOutcome`) so the provider retries instead of being told its
 * signature was bad.
 */

/**
 * Turn a PayPal refusal into an answer the caller can act on.
 *
 * These were plain Errors, so every one became `500 INTERNAL_ERROR` with "an
 * unexpected error occurred". PayPal had said why, we kept it in the log, and
 * the buyer whose payment had just failed was told nothing. On the money path
 * that is the worst place to be vague: the person cannot tell whether to retry,
 * use another card, or contact anyone.
 *
 * The `name` PayPal returns is a fixed, documented vocabulary
 * (INSTRUMENT_DECLINED, PAYER_ACTION_REQUIRED, ...). It is safe to pass on and
 * is the part that decides what the buyer should do. The `message` and
 * `details` are not forwarded: they can name the account, and this reaches a
 * browser.
 *
 * The refusal is logged here as status, PayPal's `debug_id`, `name` and
 * `message` only. The raw body can carry the payer's name, email and address,
 * and console output skips the logger's redaction.
 */
export function paypalError(operation: string, status: number, body: string): RekeyError {
  const refusal = paypalRefusal(body);
  console.error(`paypal ${operation} failed`, { status, ...refusal });
  const { name } = refusal;
  return new RekeyError({
    statusCode: 502,
    code: 'BILLING_PROVIDER_REFUSED',
    message: name
      ? `PayPal refused the ${operation} (${name}).`
      : `PayPal refused the ${operation} (HTTP ${status}).`,
    fix:
      name === 'INSTRUMENT_DECLINED'
        ? 'The payment method was declined. Ask the customer to use another one.'
        : "Check the billing credentials configured for this Application, then retry. PayPal's debug_id for the refusal is in the server log.",
  });
}

interface PaypalRefusal {
  name: string | null;
  message: string | null;
  debugId: string | null;
}

/** The identifying fields of a PayPal error body, including the OAuth `error` shape. */
function paypalRefusal(body: string): PaypalRefusal {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
  } catch {
    // Not JSON. Nothing to forward, so the status carries the meaning.
  }
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    name: text(parsed.name) ?? text(parsed.error),
    message: text(parsed.message) ?? text(parsed.error_description),
    debugId: text(parsed.debug_id),
  };
}
