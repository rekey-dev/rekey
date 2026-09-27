/**
 * The checkout page's server-side calls to the API. The buyer's browser only
 * ever talks to the portal; these carry the token on to the API with the
 * portal's caller secret and the vouched visitor address, so the API's per-IP
 * limits count the visitor, not the portal.
 */

import 'server-only';
import type { CheckoutPageView } from '@rekey.dev/shared-types';
import { CHECKOUT_TOKEN_PATTERN } from '@rekey.dev/shared-types/checkout';
import { rekeyApiUrl } from './env';
import { API_TIMEOUT_MS, forwardedClientHeaders } from './client-ip';

/** What the page does with an API answer that is not a view. */
export type CheckoutLookup =
  | { kind: 'view'; view: CheckoutPageView }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'unavailable' };

interface Envelope<T> {
  success?: boolean;
  data?: T;
  error?: { code?: string };
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Envelope<T> | null }> {
  const headers: Record<string, string> = { ...(await forwardedClientHeaders()) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${rekeyApiUrl()}/api/v1/checkout-sessions/${path}`, {
    method,
    cache: 'no-store',
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  return { status: res.status, json };
}

/** A token not shaped like one never leaves the portal. */
export function isCheckoutToken(token: string): boolean {
  return CHECKOUT_TOKEN_PATTERN.test(token);
}

/**
 * @example
 * const lookup = await lookupCheckout('chk_test_…');
 */
export async function lookupCheckout(token: string): Promise<CheckoutLookup> {
  if (!isCheckoutToken(token)) return { kind: 'not_found' };
  try {
    const { status, json } = await call<CheckoutPageView>('GET', encodeURIComponent(token));
    if (status === 200 && json?.data) return { kind: 'view', view: json.data };
    if (status === 404) return { kind: 'not_found' };
    if (status === 409 && json?.error?.code === 'CHECKOUT_MODE_MISMATCH') return { kind: 'expired' };
    return { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** The session's status, for the page's polling. Null when the API did not answer usefully. */
export async function checkoutStatus(token: string): Promise<CheckoutPageView['status'] | null> {
  if (!isCheckoutToken(token)) return null;
  try {
    const { status, json } = await call<{ status: CheckoutPageView['status'] }>('GET', `${encodeURIComponent(token)}/status`);
    if (status === 409) return 'expired';
    return status === 200 && json?.data ? json.data.status : null;
  } catch {
    return null;
  }
}

/** The processor's own page for this order, already host-checked by the API. */
export async function checkoutFallback(token: string): Promise<string | null> {
  if (!isCheckoutToken(token)) return null;
  try {
    const { status, json } = await call<{ url: string }>('POST', `${encodeURIComponent(token)}/fallback`);
    return status === 200 && json?.data ? json.data.url : null;
  } catch {
    return null;
  }
}

/**
 * Forward PayPal's approval to the API. Returns the status to answer the page
 * with and a body that names only the outcome, never the API's message.
 */
export async function confirmApproval(
  token: string,
  subscriptionId: string,
): Promise<{ status: number; body: { status?: string; error?: string } }> {
  if (!isCheckoutToken(token)) return { status: 404, body: { error: 'not_found' } };
  try {
    const { status, json } = await call<{ status: string }>('POST', `${encodeURIComponent(token)}/paypal/approved`, {
      subscriptionId,
    });
    if (status === 200 && json?.data) return { status: 200, body: { status: json.data.status } };
    return { status: status >= 400 && status < 500 ? status : 502, body: { error: json?.error?.code ?? 'unavailable' } };
  } catch {
    return { status: 502, body: { error: 'unavailable' } };
  }
}

/** The portal's half of the readiness probe: call the API back with its nonce. */
export async function confirmProbe(nonce: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) return null;
  try {
    const res = await fetch(`${rekeyApiUrl()}/api/v1/checkout/probe/${nonce}`, {
      cache: 'no-store',
      headers: await forwardedClientHeaders(),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as Envelope<{ slug: string }> | null;
    return res.status === 200 && json?.data ? json.data.slug : null;
  } catch {
    return null;
  }
}
