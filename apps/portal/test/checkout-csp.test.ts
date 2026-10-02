/**
 * The checkout page's Content-Security-Policy, and the middleware that sets it.
 *
 * The policy is the SAQ A control: only this request's nonce and the active
 * processor's origins may load scripts or frames on a page that hosts a
 * payment form. Test mode names the PayPal sandbox host explicitly; live mode
 * never does.
 */

import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { buildCheckoutCsp, CSP_REPORT_PATH } from '@/lib/checkout-csp';
import { middleware } from '@/middleware';

const TEST_TOKEN = `chk_test_${'A'.repeat(43)}`;
const LIVE_TOKEN = `chk_live_${'B'.repeat(43)}`;

function directive(csp: string, name: string): string {
  return csp.split('; ').find((d) => d === name || d.startsWith(`${name} `)) ?? '';
}

describe('buildCheckoutCsp', () => {
  it('allows scripts only from self, the nonce and the processor, never inline or eval', () => {
    const csp = buildCheckoutCsp({ nonce: 'n0nce', provider: 'paypal', mode: 'live' });
    const scripts = directive(csp, 'script-src');
    expect(scripts).toContain("'nonce-n0nce'");
    expect(scripts).toContain('https://www.paypal.com');
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(directive(csp, 'default-src')).toBe("default-src 'none'");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'none'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
    expect(directive(csp, 'report-uri')).toBe(`report-uri ${CSP_REPORT_PATH}`);
  });

  it('names the sandbox host in test mode and never in live mode', () => {
    const test = buildCheckoutCsp({ nonce: 'n', provider: 'paypal', mode: 'test' });
    const live = buildCheckoutCsp({ nonce: 'n', provider: 'paypal', mode: 'live' });
    expect(directive(test, 'script-src')).toContain('https://www.sandbox.paypal.com');
    expect(directive(test, 'frame-src')).toContain('https://www.sandbox.paypal.com');
    expect(live).not.toContain('sandbox');
  });

  it('loads no processor at all when the mode is unknown', () => {
    const csp = buildCheckoutCsp({ nonce: 'n', provider: 'paypal', mode: null });
    expect(csp).not.toContain('paypal');
    expect(directive(csp, 'frame-src')).toBe("frame-src 'none'");
  });
});

describe('buildCheckoutCsp for Razorpay', () => {
  it('admits checkout.js, its frames and the Hosted Checkout form target, in both modes', () => {
    for (const mode of ['test', 'live'] as const) {
      const csp = buildCheckoutCsp({ nonce: 'n', provider: 'razorpay', mode });
      expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-n' https://checkout.razorpay.com");
      expect(directive(csp, 'frame-src')).toContain('https://api.razorpay.com');
      expect(directive(csp, 'frame-src')).toContain('https://checkout.razorpay.com');
      expect(directive(csp, 'connect-src')).toContain('https://lumberjack.razorpay.com');
      expect(directive(csp, 'form-action')).toBe("form-action 'self' https://api.razorpay.com");
      expect(csp).not.toContain('paypal');
    }
  });

  it('keeps form-action to self for a processor that posts no form', () => {
    expect(directive(buildCheckoutCsp({ nonce: 'n', provider: 'paypal', mode: 'live' }), 'form-action')).toBe("form-action 'self'");
  });

  it("merges several processors' lists for one mode without letting live admit a sandbox host", () => {
    const live = buildCheckoutCsp({ nonce: 'n', provider: ['paypal', 'razorpay'], mode: 'live' });
    expect(directive(live, 'script-src')).toContain('https://www.paypal.com');
    expect(directive(live, 'script-src')).toContain('https://checkout.razorpay.com');
    expect(live).not.toContain('sandbox');
    expect(live).not.toContain('*.');
    const test = buildCheckoutCsp({ nonce: 'n', provider: ['paypal', 'razorpay'], mode: 'test' });
    expect(directive(test, 'script-src')).toContain('https://www.sandbox.paypal.com');
    expect(directive(test, 'script-src')).toContain('https://checkout.razorpay.com');
  });
});

describe('middleware on checkout paths', () => {
  function run(path: string) {
    return middleware(new NextRequest(`https://portal.example${path}`));
  }

  it('sets a per-request nonce policy, report-only, and forwards the same nonce to the page', () => {
    const res = run(`/acme/checkout/${TEST_TOKEN}`);
    const csp = res.headers.get('content-security-policy-report-only') ?? '';
    const forwardedNonce = res.headers.get('x-middleware-request-x-nonce') ?? '';
    expect(forwardedNonce).not.toBe('');
    expect(csp).toContain(`'nonce-${forwardedNonce}'`);
    expect(res.headers.get('x-middleware-request-content-security-policy-report-only')).toBe(csp);
    expect(csp).toContain('https://www.sandbox.paypal.com');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const again = run(`/acme/checkout/${TEST_TOKEN}`);
    expect(again.headers.get('x-middleware-request-x-nonce')).not.toBe(forwardedNonce);
  });

  it('never names a sandbox host for a live token', () => {
    const csp = run(`/acme/checkout/${LIVE_TOKEN}`).headers.get('content-security-policy-report-only') ?? '';
    expect(csp).toContain('https://www.paypal.com');
    expect(csp).toContain('https://checkout.razorpay.com');
    expect(csp).not.toContain('sandbox');
    expect(csp).not.toContain('*.paypal.com');
  });

  it('sends no second CSP on the checkout page, where Next would take its nonce from it', () => {
    const res = run(`/acme/checkout/${LIVE_TOKEN}`);
    expect(res.headers.get('content-security-policy')).toBeNull();
    // What Next reads its script nonce from, in its own order: the request's
    // enforcing header first, then the report-only one. Both carry the nonce.
    const nonce = res.headers.get('x-middleware-request-x-nonce') ?? '';
    expect(res.headers.get('x-middleware-request-content-security-policy')).toContain(`'nonce-${nonce}'`);
    expect(res.headers.get('x-middleware-request-content-security-policy-report-only')).toContain(`'nonce-${nonce}'`);
  });

  it('refuses framing on portal pages from middleware, and next.config sets no CSP of its own', async () => {
    expect(run('/acme').headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(run('/acme/login').headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    const config = (await import('../next.config.mjs')).default as { headers: () => Promise<Array<{ headers: Array<{ key: string }> }>> };
    const keys = (await config.headers()).flatMap((rule) => rule.headers.map((h) => h.key.toLowerCase()));
    expect(keys).not.toContain('content-security-policy');
    expect(keys).toContain('x-frame-options');
  });

  it('covers the checkout sub-routes and leaves portal pages alone', () => {
    expect(run(`/acme/checkout/${LIVE_TOKEN}/continue`).headers.get('content-security-policy-report-only')).not.toBeNull();
    expect(run('/acme').headers.get('content-security-policy-report-only')).toBeNull();
    expect(run('/acme/login').headers.get('content-security-policy-report-only')).toBeNull();
  });
});
