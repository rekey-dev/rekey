// @vitest-environment jsdom
/**
 * The Stripe pay region in a browser, against a fake `window.Stripe` that
 * behaves like Stripe.js where it matters: `confirm()` throws unless the
 * page read the session total first, as Stripe documents. The fake records
 * every call, so a wrong method name or order fails here, not in production.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StripePayment } from '@/components/checkout/stripe-payment';
import { STRIPE_JS_URL, type StripeAppearance } from '@/lib/stripe-elements';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = 'cs_test_a1B2c3D4';
const CLIENT = { provider: 'stripe', publishableKey: 'pk_test_abc', clientSecret: `${SESSION}_secret_x`, sdk: 'elements' } as const;
const APPEARANCE: StripeAppearance = {
  theme: 'stripe',
  variables: { colorPrimary: '#4f46e5', colorBackground: '#ffffff', colorText: '#171717', colorDanger: '#b91c1c', fontFamily: 'system-ui', borderRadius: '8px' },
};

interface FakeStripe {
  calls: string[];
  totalRead: boolean;
  zeroTotal: boolean;
  confirmArgs: unknown[];
  ready(): void;
  change(canConfirm: boolean): void;
  loadError: boolean;
  confirmResult: { type: 'success'; session: { id: string } } | { type: 'error'; error: { message: string } };
  destroyed: boolean;
}

let fake: FakeStripe;
let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const assign = vi.fn();

/** Like Stripe.js: the total counts as shown only once the formatted `amount` itself was read. */
function session(canConfirm: boolean) {
  const minorUnitsAmount = fake.zeroTotal ? 0 : 10890;
  return {
    id: SESSION,
    canConfirm,
    recurring: fake.zeroTotal ? { interval: 'month' } : null,
    total: {
      total: {
        minorUnitsAmount,
        get amount() {
          fake.totalRead = true;
          return fake.zeroTotal ? '$0.00' : '$108.90';
        },
      },
    },
  };
}

function installStripe(): void {
  let onReady: () => void = () => undefined;
  let onChange: (s: ReturnType<typeof session>) => void = () => undefined;
  fake = {
    calls: [],
    totalRead: false,
    zeroTotal: false,
    confirmArgs: [],
    loadError: false,
    destroyed: false,
    confirmResult: { type: 'success', session: { id: SESSION } },
    ready: () => onReady(),
    change: (canConfirm) => onChange(session(canConfirm)),
  };
  window.Stripe = ((pk: string) => {
    fake.calls.push(`Stripe(${pk})`);
    return {
      initCheckoutElementsSdk: (options: { clientSecret: string; elementsOptions: { appearance: { variables: { colorPrimary: string } } } }) => {
        fake.calls.push(`initCheckoutElementsSdk(${options.clientSecret},${options.elementsOptions.appearance.variables.colorPrimary})`);
        return {
          on: (event: string, handler: typeof onChange) => {
            fake.calls.push(`on(${event})`);
            onChange = handler;
          },
          createPaymentElement: (opts: { layout: string }) => {
            fake.calls.push(`createPaymentElement(${opts.layout})`);
            return {
              on: (event: string, handler: () => void) => {
                if (event === 'ready') onReady = handler;
              },
              mount: (el: HTMLElement) => fake.calls.push(`mount(#${el.id})`),
              destroy: () => {
                fake.destroyed = true;
              },
            };
          },
          loadActions: async () => {
            fake.calls.push('loadActions');
            if (fake.loadError) return { type: 'error', error: { message: 'expired' } };
            return {
              type: 'success',
              actions: {
                getSession: () => {
                  fake.calls.push('getSession');
                  return session(false);
                },
                confirm: async (args: unknown) => {
                  fake.calls.push('confirm');
                  fake.confirmArgs.push(args);
                  if (!fake.totalRead) throw new Error('You must display the total amount before confirming.');
                  return fake.confirmResult;
                },
              },
            };
          },
        };
      },
    };
  }) as unknown as typeof window.Stripe;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.head.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  assign.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);
  installStripe();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.Stripe;
});

function render(initialPhase: 'loading' | 'confirming' = 'loading'): void {
  act(() => {
    root.render(
      <StripePayment
        nonce="n0nce"
        client={CLIENT}
        appearance={APPEARANCE}
        payLabel="Pay $99.00"
        basePath="/acme/checkout/tok"
        successUrl="https://app.example/ok"
        initialPhase={initialPhase}
        providerName="Stripe"
        fallbackLabel="Continue on Stripe"
      />,
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function button(): HTMLButtonElement {
  return container.querySelector('button')!;
}

describe('StripePayment in a browser', () => {
  it('mounts the Payment Element, reads the session total, and confirms with redirect if_required', async () => {
    render();
    await flush();
    act(() => fake.ready());
    expect(button().disabled).toBe(true);
    act(() => fake.change(true));
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe('Pay $108.90');

    fetchMock.mockResolvedValueOnce(new Response('{"status":"confirming"}', { status: 200 }));
    fetchMock.mockResolvedValue(new Response('{"status":"complete"}', { status: 200 }));
    await act(async () => {
      button().click();
      await vi.advanceTimersByTimeAsync(2_100);
    });

    expect(fake.calls).toEqual([
      'Stripe(pk_test_abc)',
      'initCheckoutElementsSdk(cs_test_a1B2c3D4_secret_x,#4f46e5)',
      'createPaymentElement(tabs)',
      'mount(#stripe-payment-element)',
      'on(change)',
      'loadActions',
      'getSession',
      'confirm',
    ]);
    expect(fake.confirmArgs).toEqual([{ redirect: 'if_required' }]);
    expect(fetchMock.mock.calls[0]![0]).toBe('/acme/checkout/tok/stripe-confirmed');
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ sessionId: SESSION });
    expect(assign).toHaveBeenCalledWith('https://app.example/ok');
  });

  it('confirms a zero-total session (a trial) too, having read its total', async () => {
    fake.zeroTotal = true;
    render();
    await flush();
    act(() => {
      fake.ready();
      fake.change(true);
    });
    expect(button().textContent).toBe('Start free trial');
    fetchMock.mockResolvedValueOnce(new Response('{"status":"confirming"}', { status: 200 }));
    fetchMock.mockResolvedValue(new Response('{"status":"complete"}', { status: 200 }));
    await act(async () => {
      button().click();
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(fetchMock.mock.calls[0]![0]).toBe('/acme/checkout/tok/stripe-confirmed');
    expect(assign).toHaveBeenCalledWith('https://app.example/ok');
  });

  it('shows Stripe’s decline inline and lets the buyer try again', async () => {
    fake.confirmResult = { type: 'error', error: { message: 'Your card was declined.' } };
    render();
    await flush();
    act(() => {
      fake.ready();
      fake.change(true);
    });
    await act(async () => {
      button().click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('Your card was declined.');
    expect(button().disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Continue on Stripe');
  });

  it('offers Stripe’s own page when the session moved there, not a load failure', async () => {
    fake.loadError = true;
    render();
    await flush();
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain("This payment continues on Stripe's own page.");
    expect(container.querySelector('a')!.textContent).toBe("Continue on Stripe's page");
  });

  it('falls back after ten seconds when the form never becomes ready', async () => {
    render();
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(container.textContent).toContain('The secure payment form did not load.');
    expect(container.querySelector('a')!.getAttribute('href')).toBe('/acme/checkout/tok/continue');
  });

  it('injects Stripe.js once, with the nonce, and destroys the element on unmount', async () => {
    delete window.Stripe;
    render();
    act(() => root.render(<div />));
    render();
    const scripts = document.head.querySelectorAll(`script[src="${STRIPE_JS_URL}"]`);
    expect(scripts).toHaveLength(1);
    expect((scripts[0] as HTMLScriptElement).nonce).toBe('n0nce');

    installStripe();
    await act(async () => {
      scripts[0]!.dispatchEvent(new Event('load'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fake.calls.filter((c) => c.startsWith('mount'))).toHaveLength(1);
    act(() => root.render(<div />));
    expect(fake.destroyed).toBe(true);
  });

  it('mounts the Payment Element once under StrictMode’s double effect', async () => {
    delete window.Stripe;
    act(() => {
      root.render(
        <React.StrictMode>
          <StripePayment
            nonce="n0nce"
            client={CLIENT}
            appearance={APPEARANCE}
            payLabel="Pay $99.00"
            basePath="/acme/checkout/tok"
            successUrl="https://app.example/ok"
            initialPhase="loading"
            providerName="Stripe"
            fallbackLabel="Continue on Stripe"
          />
        </React.StrictMode>,
      );
    });
    const scripts = document.head.querySelectorAll(`script[src="${STRIPE_JS_URL}"]`);
    expect(scripts).toHaveLength(1);
    installStripe();
    await act(async () => {
      scripts[0]!.dispatchEvent(new Event('load'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fake.calls.filter((c) => c.startsWith('mount'))).toHaveLength(1);
  });

  it('polls without a form when the page opens already confirming', async () => {
    fetchMock.mockResolvedValue(new Response('{"status":"complete"}', { status: 200 }));
    render('confirming');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(container.querySelector('button')).toBeNull();
    expect(assign).toHaveBeenCalledWith('https://app.example/ok');
  });
});
