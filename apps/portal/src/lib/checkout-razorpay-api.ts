/**
 * Forward Razorpay's checkout handler response to the API, which verifies its
 * signature and moves the session to "confirming". Nothing is activated here.
 */

import 'server-only';
import type { RazorpayPaymentResponse } from '@rekey.dev/shared-types/checkout';
import { call, isCheckoutToken } from './checkout-api';

/**
 * @example
 * const { status, body } = await confirmRazorpayPayment('chk_test_…', response);
 */
export async function confirmRazorpayPayment(
  token: string,
  response: RazorpayPaymentResponse,
): Promise<{ status: number; body: { status?: string; error?: string } }> {
  if (!isCheckoutToken(token)) return { status: 404, body: { error: 'not_found' } };
  try {
    const { status, json } = await call<{ status: string }>('POST', `${encodeURIComponent(token)}/razorpay/approved`, response);
    if (status === 200 && json?.data) return { status: 200, body: { status: json.data.status } };
    return { status: status >= 400 && status < 500 ? status : 502, body: { error: json?.error?.code ?? 'unavailable' } };
  } catch {
    return { status: 502, body: { error: 'unavailable' } };
  }
}
