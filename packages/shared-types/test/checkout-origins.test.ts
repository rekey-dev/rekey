/**
 * The checkout page's processor origins: a live page must never be able to
 * load anything from a sandbox host, not even through a wildcard.
 */

import { describe, expect, it } from 'vitest';
import { CHECKOUT_BROWSER_ORIGINS } from '../src/checkout.js';

const SANDBOX_HOSTS = ['www.sandbox.paypal.com', 'api-m.sandbox.paypal.com', 'www.sandbox.venmo.com'];

/** Whether a CSP source expression allows a host, including `https://*.x` wildcards. */
function allows(source: string, host: string): boolean {
  const pattern = source.replace(/^https:\/\//, '');
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
  return pattern === host;
}

describe('CHECKOUT_BROWSER_ORIGINS', () => {
  for (const [provider, modes] of Object.entries(CHECKOUT_BROWSER_ORIGINS)) {
    it(`${provider}: no live directive allows a sandbox host`, () => {
      for (const list of Object.values(modes.live)) {
        for (const source of list) {
          for (const host of SANDBOX_HOSTS) expect(allows(source, host), `${source} allows ${host}`).toBe(false);
        }
      }
    });
  }

  it('paypal: the test lists name the sandbox host explicitly', () => {
    expect(CHECKOUT_BROWSER_ORIGINS.paypal!.test.scriptSrc).toContain('https://www.sandbox.paypal.com');
    expect(CHECKOUT_BROWSER_ORIGINS.paypal!.test.frameSrc).toContain('https://www.sandbox.paypal.com');
  });

  it('stripe: allows Stripe.js, its 3-D Secure frames and its API in both modes, from Stripe hosts only', () => {
    for (const mode of ['test', 'live'] as const) {
      const origins = CHECKOUT_BROWSER_ORIGINS.stripe![mode];
      expect(origins.scriptSrc).toContain('https://js.stripe.com');
      expect(origins.frameSrc).toEqual(expect.arrayContaining(['https://js.stripe.com', 'https://hooks.stripe.com']));
      expect(origins.connectSrc).toContain('https://api.stripe.com');
      for (const list of Object.values(origins)) {
        for (const source of list) expect(source).toMatch(/^https:\/\/(\*\.)?([a-z]+\.)*(stripe\.com|link\.com)$/);
      }
    }
  });

  it('paypal: live still allows the production script and frame host', () => {
    expect(CHECKOUT_BROWSER_ORIGINS.paypal!.live.scriptSrc).toContain('https://www.paypal.com');
    expect(CHECKOUT_BROWSER_ORIGINS.paypal!.live.frameSrc).toContain('https://www.paypal.com');
  });

  it('razorpay: the checkout script, the modal frames and the Hosted Checkout form target', () => {
    for (const mode of ['test', 'live'] as const) {
      const origins = CHECKOUT_BROWSER_ORIGINS.razorpay![mode];
      expect(origins.scriptSrc).toEqual(['https://checkout.razorpay.com']);
      expect(origins.frameSrc).toEqual(expect.arrayContaining(['https://api.razorpay.com', 'https://checkout.razorpay.com']));
      expect(origins.connectSrc).toEqual(expect.arrayContaining(['https://api.razorpay.com', 'https://lumberjack.razorpay.com']));
      expect(origins.formAction).toEqual(['https://api.razorpay.com']);
      for (const list of Object.values(origins)) for (const source of list) expect(source).not.toContain('*');
    }
  });
});
