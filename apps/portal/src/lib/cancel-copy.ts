import { cancelsAtPeriodEnd } from '@rekey.dev/shared-types';

/**
 * The two sentences a cancel confirmation is allowed to say, and which one this
 * subscription gets.
 *
 * ## Why this is a function and not inline JSX
 *
 * `atPeriodEnd: true` — the only thing the portal's cancel action ever sends —
 * is a REQUEST. The API grants it for an ACTIVE subscription with a known
 * period end and otherwise cancels on the spot, with no refund for the unused
 * remainder. A confirmation dialog has to say which of those two is about to
 * happen, and it has to say so BEFORE the call, so it cannot read the answer
 * off the response. It has to predict.
 *
 * The portal predicted wrong, unconditionally: the button read "Cancel at
 * period end" and the dialog promised the plan "stays active until the end of
 * the current period" for every subscription, including the ones the API was
 * about to terminate immediately — and including ones where the page could not
 * even name the date, since it only renders one when `currentPeriodEnd` exists.
 * #338 fixed this copy on the marketing site and did not touch the portal.
 *
 * On Rekey Cloud that gap was not theoretical. Its live PayPal subscription has
 * no `currentPeriodEnd` for the whole of its first period, so this dialog
 * promised a period end to precisely the customer who would not get one.
 *
 * The prediction itself is imported from `@rekey.dev/shared-types`, never
 * restated. Written out a second time in the marketing app it drifted from the
 * server's rule within a day of being written.
 */
export interface CancelCopy {
  /** Button that opens the confirmation. */
  label: string;
  /** Body of the confirmation. */
  message: string;
  /** Button that performs the cancellation. */
  confirmLabel: string;
  /** Whether the API will schedule this rather than cancel it outright. */
  schedules: boolean;
}

export interface CancelCopyInput {
  status: string;
  currentPeriodEnd: Date | string | null;
}

export function cancelCopy(
  subscription: CancelCopyInput,
  formatDate: (d: Date) => string = (d) => d.toLocaleDateString(),
): CancelCopy {
  const schedules = cancelsAtPeriodEnd(subscription);
  if (!schedules) {
    return {
      schedules,
      label: 'Cancel subscription',
      confirmLabel: 'Yes, cancel now',
      message:
        'This subscription has no renewal date left to run out, so cancelling takes effect ' +
        "straight away — access ends now and there's no refund for any unused time. " +
        'You can resubscribe any time.',
    };
  }
  // `schedules` is true only when `currentPeriodEnd` is non-null, but the
  // fallback stays: a promise with a blank where the date should be is worse
  // than one that declines to name it.
  const until = subscription.currentPeriodEnd
    ? formatDate(new Date(subscription.currentPeriodEnd))
    : 'the end of the period you have already paid for';
  return {
    schedules,
    label: 'Cancel at period end',
    confirmLabel: 'Cancel at period end',
    message: `Your plan stays active until ${until}, then won't renew. You can resubscribe any time.`,
  };
}
