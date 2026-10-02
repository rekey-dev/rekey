// @vitest-environment jsdom
/**
 * The Razorpay pay region in a browser: checkout.js loads with the request's
 * nonce, our button opens Standard Checkout on the server-created id with the
 * operator's branding, closing the modal says nothing was charged, a paid
 * handler is verified then polled, and a script that never loads offers the
 * fallback.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutPageOrder, CheckoutPageView } from '@rekey.dev/shared-types';
import { RazorpayPayment, RAZORPAY_SCRIPT, type RazorpayTarget } from '@/components/checkout/razorpay-payment';
import type { RazorpayFallbackTarget } from '@/components/checkout/razorpay-fallback';
import { CheckoutView } from '@/components/checkout/checkout-view';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Options = Record<string, unknown> & {
  handler: (r: Record<string, string>) => void;
  modal: { ondismiss: () => void };
};

let container: HTMLDivElement;
let root: Root;
let opened: Options[];
const fetchMock = vi.fn();
const assign = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  opened = [];
  document.head.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  assign.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);
  window.Razorpay = class {
    constructor(private readonly options: Options) {}
    open(): void {
      opened.push(this.options);
    }
  } as unknown as typeof window.Razorpay;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.Razorpay;
});

const LINK: RazorpayFallbackTarget = { kind: 'link', href: '/acme/checkout/tok/continue' };

function mount(
  target: RazorpayTarget,
  extra: Partial<{
    upiFirst: boolean;
    fallback: RazorpayFallbackTarget;
    initialPhase: 'loading' | 'confirming' | 'claimed' | 'unconfirmed' | 'failed';
  }> = {},
): void {
  act(() => {
    root.render(
      <RazorpayPayment
        nonce="n0nce"
        keyId="rzp_test_ci"
        target={target}
        basePath="/acme/checkout/tok"
        successUrl="https://app.example/account?paid=1"
        initialPhase={extra.initialPhase ?? 'loading'}
        merchant={{ name: 'Acme Labs', image: 'https://cdn.example/logo.png', color: '#0d9488' }}
        buyerEmail="buyer@example.com"
        description="100 credits"
        upiFirst={extra.upiFirst ?? true}
        payLabel="Pay ₹199.00"
        providerName="Razorpay"
        fallbackLabel="Continue on Razorpay"
        fallback={extra.fallback ?? LINK}
      />,
    );
  });
}

function loadScript(): HTMLScriptElement {
  const script = document.head.querySelector('script')!;
  act(() => script.onload!(new Event('load')));
  return script;
}

function button(): HTMLButtonElement {
  return container.querySelector('button.ck-button')!;
}

function status(): string {
  return container.querySelector('#payment-status')!.textContent ?? '';
}

describe('RazorpayPayment', () => {
  it('loads checkout.js with the nonce and opens Standard Checkout on the order with the operator branding', () => {
    mount({ kind: 'order', orderId: 'order_9' });
    expect(container.querySelector('.ck-button-skeleton')).not.toBeNull();
    const script = loadScript();
    expect(script.src).toBe(RAZORPAY_SCRIPT);
    expect(script.nonce).toBe('n0nce');
    expect(button().textContent).toBe('Pay ₹199.00');
    act(() => button().click());
    expect(opened).toHaveLength(1);
    const options = opened[0]!;
    expect(options).toMatchObject({
      key: 'rzp_test_ci',
      order_id: 'order_9',
      name: 'Acme Labs',
      description: '100 credits',
      image: 'https://cdn.example/logo.png',
      prefill: { email: 'buyer@example.com' },
      theme: { color: '#0d9488' },
    });
    expect('subscription_id' in options).toBe(false);
    expect((options.config as { display: { sequence: string[] } }).display.sequence).toEqual(['block.upi']);
    expect(button().disabled).toBe(true);
  });

  it('opens a subscription by its id, and orders no method block outside INR', () => {
    mount({ kind: 'subscription', subscriptionId: 'sub_7' }, { upiFirst: false });
    loadScript();
    act(() => button().click());
    expect(opened[0]).toMatchObject({ subscription_id: 'sub_7' });
    expect('order_id' in opened[0]!).toBe(false);
    expect('config' in opened[0]!).toBe(false);
  });

  it('keeps the button live when the modal is closed, without claiming nothing was charged', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'open' }), { status: 200 }));
    mount({ kind: 'order', orderId: 'order_9' });
    loadScript();
    act(() => button().click());
    await act(async () => {
      opened[0]!.modal.ondismiss();
    });
    expect(status()).toBe('Payment not completed. If you approved it in your UPI app, wait a moment before trying again.');
    expect(fetchMock.mock.calls[0]![0]).toBe('/acme/checkout/tok/status');
    expect(button().disabled).toBe(false);
  });

  it('moves on to confirming when the payment went through as the modal closed', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'confirming' }), { status: 200 }));
    mount({ kind: 'order', orderId: 'order_9' });
    loadScript();
    act(() => button().click());
    await act(async () => {
      opened[0]!.modal.ondismiss();
    });
    expect(status()).toBe('Payment received. Confirming your payment…');
    expect(button()).toBeNull();
  });

  it('does not send the buyer on as paid when a claimed payment never left open', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ status: 'open' }), { status: 200 }));
    mount({ kind: 'order', orderId: 'order_9' }, { initialPhase: 'claimed' });
    expect(status()).toBe('Payment received. Confirming your payment…');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(22_000);
    });
    expect(status()).toContain('We could not confirm this payment with Razorpay. Please do not pay again');
    expect(assign).not.toHaveBeenCalled();
    expect(button()).toBeNull();
  });

  it('still sends the buyer on after a claimed payment the session confirms', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ status: 'confirming' }), { status: 200 }));
    mount({ kind: 'order', orderId: 'order_9' }, { initialPhase: 'claimed' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(22_000);
    });
    expect(assign).toHaveBeenCalledWith('https://app.example/account?paid=1');
  });

  it('shows the do-not-pay-again message, no button and no script, for a refused Hosted Checkout payment', () => {
    mount({ kind: 'order', orderId: 'order_9' }, { initialPhase: 'unconfirmed' });
    expect(status()).toContain('Please do not pay again');
    expect(button()).toBeNull();
    expect(document.head.querySelector('script')).toBeNull();
  });

  it('starts waiting for the webhook, with no Pay button, when the session is already confirming', () => {
    mount({ kind: 'order', orderId: 'order_9' }, { initialPhase: 'confirming' });
    expect(status()).toBe('Payment received. Confirming your payment…');
    expect(button()).toBeNull();
    expect(container.querySelector('.ck-button-skeleton')).toBeNull();
    expect(document.head.querySelector('script')).toBeNull();
  });

  it('says a payment Hosted Checkout reported failed was not charged, and offers the button', () => {
    mount({ kind: 'order', orderId: 'order_9' }, { initialPhase: 'failed' });
    loadScript();
    expect(status()).toBe('The payment failed. You have not been charged. You can try again.');
    expect(button().disabled).toBe(false);
  });

  it('verifies a paid handler response, then polls until the webhook completes it', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'confirming' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'complete' }), { status: 200 }));
    mount({ kind: 'order', orderId: 'order_9' });
    loadScript();
    act(() => button().click());
    await act(async () => {
      opened[0]!.handler({ razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_9', razorpay_signature: 'ab'.repeat(32) });
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('/acme/checkout/tok/razorpay/approved');
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)).toEqual({
      paymentId: 'pay_1',
      signature: 'ab'.repeat(32),
      orderId: 'order_9',
    });
    expect(status()).toBe('Payment received. Confirming your payment…');
    expect(button()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchMock.mock.calls[1]![0]).toBe('/acme/checkout/tok/status');
    expect(status()).toBe('Payment confirmed. Taking you back…');
    expect(assign).toHaveBeenCalledWith('https://app.example/account?paid=1');
  });

  it('never offers the button again when Razorpay took a payment Rekey could not confirm', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'CHECKOUT_CONFIRMATION_REFUSED' }), { status: 409 }));
    mount({ kind: 'subscription', subscriptionId: 'sub_7' });
    loadScript();
    act(() => button().click());
    await act(async () => {
      opened[0]!.handler({ razorpay_payment_id: 'pay_1', razorpay_subscription_id: 'sub_7', razorpay_signature: 'ab'.repeat(32) });
    });
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)).toMatchObject({ subscriptionId: 'sub_7' });
    expect(status()).toContain('We could not confirm this payment with Razorpay. Please do not pay again');
    expect(button()).toBeNull();
  });

  it('offers the fallback when checkout.js does not load within 10 seconds', () => {
    mount({ kind: 'subscription', subscriptionId: 'sub_7' });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(status()).toBe('The secure payment form did not load.');
    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/acme/checkout/tok/continue');
    expect(link.textContent).toBe('Continue on Razorpay');
  });

  it('offers the Hosted Checkout form for an order whose script failed', () => {
    mount({ kind: 'order', orderId: 'order_9' }, { fallback: { kind: 'hosted', fields: [['order_id', 'order_9']] } });
    const script = document.head.querySelector('script')!;
    act(() => script.onerror!(new Event('error')));
    const formEl = container.querySelector('form')!;
    expect(formEl.getAttribute('action')).toBe('https://api.razorpay.com/v1/checkout/embedded');
    expect(formEl.getAttribute('method')).toBe('post');
    expect((formEl.querySelector('input[name="order_id"]') as HTMLInputElement).value).toBe('order_9');
  });

  describe('from the checkout page', () => {
    function order(target: RazorpayTarget, currency: string): CheckoutPageOrder {
      return {
        merchant: {
          displayName: 'Acme Labs',
          logoUrl: null,
          primaryColor: '#0d9488',
          backgroundColor: null,
          surfaceColor: null,
          supportEmail: null,
          supportUrl: null,
          termsUrl: null,
          privacyUrl: null,
          refundUrl: null,
        },
        plan:
          target.kind === 'order'
            ? { name: 'Pack', amount: 19900, currency, interval: null, kind: 'one_time' }
            : { name: 'Standard', amount: 49900, currency, interval: 'MONTH', kind: 'recurring' },
        discountAmount: 0,
        totalDueToday: target.kind === 'order' ? 19900 : 49900,
        buyerEmail: 'buyer@example.com',
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/account',
        manageUrl: null,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        client: { provider: 'razorpay', keyId: 'rzp_test_ci', sdk: 'razorpay-checkout', target },
      };
    }

    function openFromPage(o: CheckoutPageOrder): Record<string, unknown> {
      const view: CheckoutPageView = { status: 'open', slug: 'acme', paymentMode: 'test', provider: 'razorpay', returnUrl: o.cancelUrl, order: o };
      act(() => root.render(<CheckoutView view={view} order={o} nonce="n0nce" basePath="/acme/checkout/tok" locale="en-IN" />));
      loadScript();
      act(() => button().click());
      return opened.at(-1)!;
    }

    it("does not treat the page's paid flag as a payment when the session stays open", async () => {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ status: 'open' }), { status: 200 }));
      const o = order({ kind: 'order', orderId: 'order_1' }, 'INR');
      const view: CheckoutPageView = { status: 'open', slug: 'acme', paymentMode: 'test', provider: 'razorpay', returnUrl: o.cancelUrl, order: o };
      act(() => root.render(<CheckoutView view={view} order={o} nonce="n0nce" basePath="/acme/checkout/tok" locale="en-IN" razorpayReturn="paid" />));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(22_000);
      });
      expect(status()).toContain('Please do not pay again');
      expect(assign).not.toHaveBeenCalled();
    });

    it('sends no method ordering for an INR subscription, which Razorpay does not apply to recurring payments', () => {
      expect('config' in openFromPage(order({ kind: 'subscription', subscriptionId: 'sub_1' }, 'INR'))).toBe(false);
    });

    it('puts UPI first for an INR order only', () => {
      expect(openFromPage(order({ kind: 'order', orderId: 'order_1' }, 'INR'))).toHaveProperty('config.display.sequence', ['block.upi']);
    });

    it('sends no method ordering for an order in another currency', () => {
      expect('config' in openFromPage(order({ kind: 'order', orderId: 'order_2' }, 'USD'))).toBe(false);
    });
  });
});
