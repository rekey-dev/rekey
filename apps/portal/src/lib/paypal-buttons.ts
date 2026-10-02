/**
 * PayPal's v5 Buttons for one checkout session: the script URL to load and
 * the exact options handed to `paypal.Buttons`. Pure, so the shape is
 * testable without a browser.
 *
 * The subscription or order already exists at PayPal, created by the API with
 * this checkout's price and `custom_id`. The callbacks only hand its id back,
 * so the browser never calls `actions.subscription.create` or
 * `actions.order.create` and cannot change what is charged.
 */

import type { PaypalCheckoutPageClient } from '@rekey.dev/shared-types';
import type { PaypalApprovalBody } from '@rekey.dev/shared-types/checkout';

export const PAYPAL_SDK_ORIGIN = 'https://www.paypal.com';

export interface PaypalButtonsStyle {
  layout: 'vertical';
  label: 'subscribe' | 'pay';
  shape: 'rect';
  color: 'gold';
}

/** What PayPal passes to `onApprove`, for either flow. */
export interface PaypalApproveData {
  subscriptionID?: string | null;
  orderID?: string | null;
}

interface CommonOptions {
  style: PaypalButtonsStyle;
  onApprove: (data: PaypalApproveData) => Promise<void>;
  onCancel: () => void;
  onError: () => void;
}

/** The options for `paypal.Buttons`: one create callback, matching the script's `intent`. */
export type PaypalButtonsOptions =
  | (CommonOptions & { createSubscription: () => Promise<string> })
  | (CommonOptions & { createOrder: () => Promise<string> });

export interface PaypalButtonsHandlers {
  /** PayPal said yes; `body` is what the page posts to `…/approved`. */
  onApprove: (body: PaypalApprovalBody) => Promise<void>;
  onCancel: () => void;
  onError: () => void;
}

/**
 * @example
 * paypalSdkUrl({ provider: 'paypal', clientId: 'AbC', orderId: '5O1', sdk: 'v5-order', currency: 'EUR' });
 * // 'https://www.paypal.com/sdk/js?client-id=AbC&intent=capture&currency=EUR&components=buttons'
 */
export function paypalSdkUrl(client: PaypalCheckoutPageClient): string {
  const params =
    client.sdk === 'v5-order'
      ? new URLSearchParams({ 'client-id': client.clientId, intent: 'capture', currency: client.currency, components: 'buttons' })
      : new URLSearchParams({ 'client-id': client.clientId, vault: 'true', intent: 'subscription', components: 'buttons' });
  return `${PAYPAL_SDK_ORIGIN}/sdk/js?${params.toString()}`;
}

/**
 * @example
 * window.paypal.Buttons(paypalButtonsOptions(order.client, { onApprove, onCancel, onError }));
 */
export function paypalButtonsOptions(client: PaypalCheckoutPageClient, handlers: PaypalButtonsHandlers): PaypalButtonsOptions {
  const { onCancel, onError } = handlers;
  if (client.sdk === 'v5-order') {
    const orderId = client.orderId;
    return {
      style: { layout: 'vertical', label: 'pay', shape: 'rect', color: 'gold' },
      createOrder: async () => orderId,
      onApprove: (data) => handlers.onApprove({ orderId: data.orderID ?? '' }),
      onCancel,
      onError,
    };
  }
  const subscriptionId = client.subscriptionId;
  return {
    style: { layout: 'vertical', label: 'subscribe', shape: 'rect', color: 'gold' },
    createSubscription: async () => subscriptionId,
    onApprove: (data) => handlers.onApprove({ subscriptionId: data.subscriptionID ?? '' }),
    onCancel,
    onError,
  };
}
