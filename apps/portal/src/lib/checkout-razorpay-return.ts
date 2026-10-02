/**
 * The query flag the Hosted Checkout return route puts on the page URL. It
 * only chooses what the page shows first; the session's state is the API's.
 */

export const RAZORPAY_RETURN_PARAM = 'razorpay';

/**
 * `paid`: Razorpay said paid and the API accepted it, or could not be asked.
 * `unconfirmed`: Razorpay said paid and the API did not confirm it.
 * `failed`: Razorpay reported a failed payment.
 */
export type RazorpayReturn = 'paid' | 'unconfirmed' | 'failed';

/**
 * @example
 * razorpayReturnOf('paid'); // 'paid'
 * razorpayReturnOf(['paid', 'x']); // null
 */
export function razorpayReturnOf(value: string | string[] | undefined): RazorpayReturn | null {
  return value === 'paid' || value === 'unconfirmed' || value === 'failed' ? value : null;
}
