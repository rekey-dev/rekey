/**
 * What the checkout page does after the provider has said yes in its window.
 *
 * Once the provider has approved, the subscription or order exists there and
 * completes from the provider's webhook whatever Rekey's confirmation call
 * answers. Telling the buyer "you have not been charged" at that point invites
 * a second attempt and a second purchase. So only one answer stops the page
 * from waiting for the webhook: Rekey checked with the provider and the
 * provider does not confirm this approval for this checkout. Everything else (a timeout, a 5xx,
 * a refusal limit, a network error) waits and then returns the buyer to the
 * app, as a successful confirmation does.
 */

export type AfterApproval = 'wait_for_webhook' | 'unconfirmed';

/** The one refusal after which the page does not wait. */
export const REFUSED_CODE = 'CHECKOUT_CONFIRMATION_REFUSED';

/**
 * @example
 * afterApproval({ ok: false, errorCode: 'CHECKOUT_CONFIRMATION_LIMIT' }); // 'wait_for_webhook'
 */
export function afterApproval(answer: { ok: boolean; errorCode: string | null } | null): AfterApproval {
  if (answer !== null && !answer.ok && answer.errorCode === REFUSED_CODE) return 'unconfirmed';
  return 'wait_for_webhook';
}

/**
 * The page's last word after the polling window, once PayPal has approved.
 * A session still waiting (or unread) is the late-webhook case: the buyer goes
 * back to the app, which shows "activates shortly". One the API calls expired
 * (the approval landed after the link ran out) stays on the page with the
 * "do not pay again" message; its webhook still completes the payment.
 *
 * @example
 * afterPolling('expired'); // 'unconfirmed'
 */
export function afterPolling(lastStatus: string | undefined): 'finish' | 'unconfirmed' {
  return lastStatus === 'expired' ? 'unconfirmed' : 'finish';
}

/**
 * Shown when the provider does not confirm. Never claims the buyer was not
 * charged. `provider` is the name from the page's provider copy.
 *
 * @example
 * unconfirmedMessage('Razorpay'); // 'We could not confirm this payment with Razorpay. …'
 */
export function unconfirmedMessage(provider: string): string {
  return `We could not confirm this payment with ${provider}. Please do not pay again: if ${provider} took the payment, your account updates within a few minutes. Otherwise, contact the business you are buying from.`;
}
