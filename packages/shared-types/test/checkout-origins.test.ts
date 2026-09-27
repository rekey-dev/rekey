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

  it('paypal: live still allows the production script and frame host', () => {
    expect(CHECKOUT_BROWSER_ORIGINS.paypal!.live.scriptSrc).toContain('https://www.paypal.com');
    expect(CHECKOUT_BROWSER_ORIGINS.paypal!.live.frameSrc).toContain('https://www.paypal.com');
  });
});
