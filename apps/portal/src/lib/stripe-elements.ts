/**
 * The checkout page's side of Stripe's Checkout Sessions `ui_mode: 'elements'`:
 * where Stripe.js comes from, the slice of its API the page calls, and how
 * the Application's colours reach the Payment Element.
 *
 * Stripe.js is loaded straight from js.stripe.com, never bundled or
 * self-hosted, which Stripe requires and which keeps card entry inside
 * Stripe's frames (SAQ A). The types below mirror `@stripe/stripe-js` for the
 * pinned release train, narrowed to what the page uses.
 *
 * Imported by the client component, so nothing here may import a server-only
 * module; the colour mapping that does is in `stripe-appearance.ts`.
 */

import type { CheckoutPageOrder } from '@rekey.dev/shared-types';
import { STRIPE_JS_RELEASE_TRAIN } from '@rekey.dev/shared-types/checkout';

/** Stripe.js for the release train of the API version the API pins. */
export const STRIPE_JS_URL = `https://js.stripe.com/${STRIPE_JS_RELEASE_TRAIN}/stripe.js`;

/** Where the page's Stripe confirmation goes, under the page's own path. */
export const STRIPE_CONFIRMED_PATH = 'stripe-confirmed';

export interface StripeAppearance {
  theme: 'stripe';
  variables: {
    colorPrimary: string;
    colorBackground: string;
    colorText: string;
    colorDanger: string;
    fontFamily: string;
    borderRadius: string;
  };
}

export interface StripePaymentElement {
  mount(container: HTMLElement): void;
  on(event: 'ready' | 'loaderror', handler: () => void): void;
  destroy(): void;
}

/** The parts of Stripe's Checkout session object the page reads. */
export interface StripeCheckoutSessionView {
  id: string;
  canConfirm: boolean;
  recurring: unknown;
  total: { total: { minorUnitsAmount: number; amount: string } };
}

export type StripeConfirmResult =
  | { type: 'success'; session: { id: string } }
  | { type: 'error'; error: { message: string } };

export interface StripeCheckoutActions {
  getSession(): StripeCheckoutSessionView;
  confirm(args: { redirect: 'if_required' }): Promise<StripeConfirmResult>;
}

export interface StripeCheckoutElementsSdk {
  on(event: 'change', handler: (session: StripeCheckoutSessionView) => void): void;
  createPaymentElement(options: { layout: 'tabs' }): StripePaymentElement;
  loadActions(): Promise<{ type: 'success'; actions: StripeCheckoutActions } | { type: 'error'; error: { message: string } }>;
}

export interface StripeInstance {
  initCheckoutElementsSdk(options: {
    clientSecret: string;
    elementsOptions: { appearance: StripeAppearance; loader: 'never' };
  }): StripeCheckoutElementsSdk;
}

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeInstance;
  }
}

/**
 * The Pay button's label before Stripe.js has loaded: the amount the order
 * summary shows, or what starts when nothing is due.
 *
 * @example
 * payButtonLabel(order, '$99.00'); // 'Pay $99.00'
 */
export function payButtonLabel(
  order: Pick<CheckoutPageOrder, 'totalDueToday' | 'discountAmount' | 'plan'>,
  total: string,
): string {
  if (order.totalDueToday > 0) return `Pay ${total}`;
  const trial = order.plan.kind === 'recurring' && order.discountAmount < order.plan.amount;
  return trial ? 'Start free trial' : 'Confirm order';
}

/**
 * The Pay button's label from Stripe's own session total. Stripe requires the
 * page to show this total before `confirm()`, which otherwise throws, and it
 * is the amount actually charged (tax and discounts included).
 *
 * @example
 * sessionPayLabel(actions.getSession()); // 'Pay $99.00'
 */
export function sessionPayLabel(session: StripeCheckoutSessionView): string {
  // `amount` is read on every path: Stripe counts the total as shown only
  // when the formatted amount (or all its parts) was read, zero included.
  const { amount, minorUnitsAmount } = session.total.total;
  if (minorUnitsAmount > 0) return `Pay ${amount}`;
  return session.recurring ? 'Start free trial' : 'Confirm order';
}
