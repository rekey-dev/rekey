/**
 * The PayPal Buttons the checkout page renders: which script each flow loads,
 * and the exact options `PaypalPayment` hands to `paypal.Buttons`, so the
 * browser only ever returns the id the API created and posts it back as the
 * approval body the API expects.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CheckoutPageClient } from '@rekey.dev/shared-types';
import { parsePaypalApproval } from '@rekey.dev/shared-types/checkout';
import { paypalButtonsOptions, paypalSdkUrl } from '@/lib/paypal-buttons';
import { PAYMENT_MESSAGES } from '@/components/checkout/paypal-payment';

const order: CheckoutPageClient = { provider: 'paypal', clientId: 'AbC-1', orderId: '5O190127TN364715T', sdk: 'v5-order', currency: 'EUR' };
const subscription: CheckoutPageClient = { provider: 'paypal', clientId: 'AbC-1', subscriptionId: 'I-SUB1', sdk: 'v5-subscription' };

function handlers() {
  return { onApprove: vi.fn(async () => undefined), onCancel: vi.fn(), onError: vi.fn() };
}

describe('PayPal Buttons for a one-time order', () => {
  it('loads the capture SDK in the order currency, without vault', () => {
    const url = new URL(paypalSdkUrl(order));
    expect(url.origin + url.pathname).toBe('https://www.paypal.com/sdk/js');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'client-id': 'AbC-1',
      intent: 'capture',
      currency: 'EUR',
      components: 'buttons',
    });
  });

  it('gives Buttons only createOrder, returning the server-created id, and posts { orderId } on approval', async () => {
    const h = handlers();
    const options = paypalButtonsOptions(order, h);
    expect(options.style).toEqual({ layout: 'vertical', label: 'pay', shape: 'rect', color: 'gold' });
    expect('createSubscription' in options).toBe(false);
    expect('createOrder' in options && (await options.createOrder())).toBe('5O190127TN364715T');
    await options.onApprove({ orderID: '5O190127TN364715T' });
    expect(h.onApprove).toHaveBeenCalledWith({ orderId: '5O190127TN364715T' });
    expect(parsePaypalApproval(h.onApprove.mock.calls[0]![0])).toEqual({ orderId: '5O190127TN364715T' });
    options.onCancel();
    options.onError();
    expect(h.onCancel).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledOnce();
  });
});

describe('PayPal Buttons for a subscription', () => {
  it('keeps the vaulted subscription SDK and body unchanged', async () => {
    expect(Object.fromEntries(new URL(paypalSdkUrl(subscription)).searchParams)).toEqual({
      'client-id': 'AbC-1',
      vault: 'true',
      intent: 'subscription',
      components: 'buttons',
    });
    const h = handlers();
    const options = paypalButtonsOptions(subscription, h);
    expect(options.style.label).toBe('subscribe');
    expect('createOrder' in options).toBe(false);
    expect('createSubscription' in options && (await options.createSubscription())).toBe('I-SUB1');
    await options.onApprove({ subscriptionID: 'I-SUB1' });
    expect(h.onApprove).toHaveBeenCalledWith({ subscriptionId: 'I-SUB1' });
  });
});

describe('payment region copy', () => {
  it('never says confirmed when the webhook has not confirmed yet', () => {
    expect(PAYMENT_MESSAGES.handing_off).toMatch(/approved and being processed/i);
    expect(PAYMENT_MESSAGES.handing_off).not.toMatch(/confirmed/i);
    expect(PAYMENT_MESSAGES.redirecting).toMatch(/confirmed/i);
  });
});
