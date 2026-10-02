/**
 * "Continue on Razorpay", for when checkout.js does not load. Works with
 * scripts blocked.
 *
 * A subscription has a Razorpay page of its own (`short_url`), reached through
 * the host-checked `continue` route. An order has none, so it is posted to
 * Razorpay Hosted Checkout, which pays the SAME order: `order.paid` then
 * completes it like a payment in the modal, and Razorpay will not take a
 * second payment for an order that is paid. Every field posted is public.
 */

import * as React from 'react';

export const RAZORPAY_HOSTED_CHECKOUT = 'https://api.razorpay.com/v1/checkout/embedded';

export type RazorpayFallbackTarget =
  | { kind: 'link'; href: string }
  | { kind: 'hosted'; fields: ReadonlyArray<readonly [string, string]> };

export function RazorpayFallback({ target, label }: { target: RazorpayFallbackTarget; label: string }): React.JSX.Element {
  if (target.kind === 'link') {
    return (
      <a className="ck-link inline-flex min-h-[44px] items-center" href={target.href}>
        {label}
      </a>
    );
  }
  return (
    <form method="post" action={RAZORPAY_HOSTED_CHECKOUT}>
      {target.fields.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" className="ck-link inline-flex min-h-[44px] items-center">
        {label}
      </button>
    </form>
  );
}
