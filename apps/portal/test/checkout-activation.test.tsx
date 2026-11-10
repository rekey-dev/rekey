// @vitest-environment jsdom
/**
 * Back from checkout, the dashboard re-reads itself until the subscription is
 * active, says so in a live region, and drops the checkout flag from the
 * address so a reload does not replay it. It stops asking after a while.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { CheckoutActivation, REFRESH_EVERY_MS, REFRESH_FOR_MS } = await import('@/components/checkout-activation');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockReset();
  window.history.replaceState(null, '', '/acme?checkout=success&tab=1');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function show(activated: boolean): void {
  act(() => root.render(<CheckoutActivation activated={activated} />));
}

describe('the dashboard after checkout', () => {
  it('re-reads the page until the subscription is active, then clears the flag', () => {
    show(false);
    expect(container.textContent).toContain('will activate shortly');
    act(() => vi.advanceTimersByTime(REFRESH_EVERY_MS * 2));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(window.location.search).toBe('?checkout=success&tab=1');

    show(true);
    const region = container.querySelector('[aria-live="polite"]');
    expect(region?.textContent).toBe('Checkout complete. Your subscription is active.');
    expect(window.location.pathname + window.location.search).toBe('/acme?tab=1');
    act(() => vi.advanceTimersByTime(REFRESH_EVERY_MS * 3));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('stops asking after its cap, says so, and does not replay on reload', () => {
    show(false);
    act(() => vi.advanceTimersByTime(REFRESH_FOR_MS + REFRESH_EVERY_MS));
    const calls = refresh.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(REFRESH_FOR_MS / REFRESH_EVERY_MS);
    expect(container.textContent).toContain('taking longer than usual');
    expect(window.location.search).toBe('?tab=1');
    act(() => vi.advanceTimersByTime(REFRESH_EVERY_MS * 5));
    expect(refresh).toHaveBeenCalledTimes(calls);
  });
});
