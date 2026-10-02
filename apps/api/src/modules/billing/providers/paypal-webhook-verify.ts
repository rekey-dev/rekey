/**
 * Online verification of an inbound PayPal webhook, see `verifyPaypalWebhook`.
 */

import type { PaypalCredentials, BillingMode } from '../credentials.service.js';
import { LIVE_BASE, PAYPAL_WEBHOOK_TIMEOUT_MS, SANDBOX_BASE, paypalFetch } from './paypal-http.js';

/**
 * The three ways an online verification can end.
 *
 * `unreachable` is separated from `invalid` deliberately. Both used to be
 * `false`, so a PayPal outage or a timeout surfaced as HTTP 401
 * WEBHOOK_SIGNATURE_INVALID, telling PayPal its own signature was bad. PayPal
 * disables an endpoint that keeps rejecting, so an outage on OUR side of the
 * call could cost the operator their webhook. `unreachable` maps to 503, which
 * is retried and reads correctly in the logs.
 *
 * Both are still fail-CLOSED: nothing is processed either way.
 */
export type PaypalVerifyOutcome =
  | { ok: true }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'unreachable' };

/**
 * The verify-webhook-signature request with the event spliced in as the bytes
 * PayPal signed. PayPal's signature covers a CRC32 of the body, so a
 * re-serialised event (reordered keys, `1.0` becoming `1`, dropped
 * whitespace) is not what was signed, and the check no longer binds to the
 * exact bytes we act on.
 */
function verificationRequestBody(fields: Record<string, string>, rawEvent: string): string | null {
  // Only a single JSON value may be spliced: raw text such as
  // `{},"webhook_id":"..."` would otherwise add or override request fields.
  try {
    JSON.parse(rawEvent);
  } catch {
    return null;
  }
  const withoutEvent = JSON.stringify(fields);
  return `${withoutEvent.slice(0, -1)},"webhook_event":${rawEvent}}`;
}

/**
 * Verify an inbound PayPal webhook signature.
 *
 * PayPal verification is ONLINE (unlike Stripe's offline HMAC): we POST the
 * transmission headers + the event body as received + our webhook id to
 * `/v1/notifications/verify-webhook-signature` and trust the
 * `verification_status`. Requires a fresh access token minted from the
 * Application's PayPal client credentials.
 *
 * `{ ok: true }` only on `verification_status === 'SUCCESS'`. A missing
 * transmission header or an explicit non-SUCCESS is `invalid`; a timeout,
 * network error or 5xx from PayPal is `unreachable`.
 *
 * Both calls carry PAYPAL_WEBHOOK_TIMEOUT_MS, see the constant for why this
 * is the sharpest of the eleven calls in this file.
 */
export async function verifyPaypalWebhook(args: {
  creds: PaypalCredentials;
  mode: BillingMode;
  headers: Record<string, string | string[] | undefined>;
  /**
   * The webhook body exactly as received. Must already have parsed as one
   * JSON value: it is embedded verbatim in the verification request.
   */
  rawEvent: string;
}): Promise<PaypalVerifyOutcome> {
  const base = args.mode === 'live' ? LIVE_BASE : SANDBOX_BASE;

  const header = (k: string): string | undefined => {
    const v = args.headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : typeof v === 'string' ? v : undefined;
  };
  const transmissionId = header('paypal-transmission-id');
  const transmissionTime = header('paypal-transmission-time');
  const certUrl = header('paypal-cert-url');
  const authAlgo = header('paypal-auth-algo');
  const transmissionSig = header('paypal-transmission-sig');
  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    // Nothing was sent to verify with, that is the caller's problem, not
    // PayPal's availability.
    return { ok: false, reason: 'invalid' };
  }
  const verifyBody = verificationRequestBody(
    {
      transmission_id: transmissionId,
      transmission_time: transmissionTime,
      cert_url: certUrl,
      auth_algo: authAlgo,
      transmission_sig: transmissionSig,
      webhook_id: args.creds.webhookId,
    },
    args.rawEvent,
  );
  if (verifyBody === null) return { ok: false, reason: 'invalid' };

  // Mint an access token (basic-auth client_credentials).
  const auth = Buffer.from(`${args.creds.clientId}:${args.creds.clientSecret}`).toString('base64');
  let token: string;
  try {
    const tokenRes = await paypalFetch(
      `${base}/v1/oauth2/token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      },
      PAYPAL_WEBHOOK_TIMEOUT_MS,
    );
    // 401/403 here means the operator's stored client credentials are wrong,
    // which is a configuration fault they must fix; anything else is PayPal
    // failing to answer.
    if (!tokenRes.ok) {
      return tokenRes.status === 401 || tokenRes.status === 403
        ? { ok: false, reason: 'invalid' }
        : { ok: false, reason: 'unreachable' };
    }
    token = ((await tokenRes.json()) as { access_token: string }).access_token;
  } catch {
    // Timeout / DNS / connection reset.
    return { ok: false, reason: 'unreachable' };
  }

  try {
    const verifyRes = await paypalFetch(
      `${base}/v1/notifications/verify-webhook-signature`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: verifyBody,
      },
      PAYPAL_WEBHOOK_TIMEOUT_MS,
    );
    if (!verifyRes.ok) {
      return verifyRes.status >= 500
        ? { ok: false, reason: 'unreachable' }
        : { ok: false, reason: 'invalid' };
    }
    const json = (await verifyRes.json()) as { verification_status?: string };
    return json.verification_status === 'SUCCESS'
      ? { ok: true }
      : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
