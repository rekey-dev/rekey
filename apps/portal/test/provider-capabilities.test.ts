/**
 * The portal asks what a billing provider can do, never which one it is.
 *
 * Before this, the dashboard hid the cancel button on `provider === 'external'`
 * and the checkout action forwarded only stripe/paypal/razorpay, silently
 * auto-routing a buyer who picked anything else (EtherLabZ/Rekey#511). The
 * fifth provider below exists to prove neither decision carries a name.
 */

import { describe, expect, it } from 'vitest';
import {
  isCheckoutProvider,
  managedElsewhere,
  resolveCheckoutProvider,
  type ProviderInfo,
} from '../src/lib/provider-capabilities';

const hosted = (provider: string): ProviderInfo => ({ provider, capabilities: { checkout: true } });

describe('managedElsewhere', () => {
  it('keeps the cancel button for the three hosted providers', () => {
    for (const provider of ['stripe', 'paypal', 'razorpay']) {
      expect(managedElsewhere({ provider, providerCapabilities: { checkout: true } } as never)).toBe(false);
      // A server predating `checkout` leaves it out; absent means it can.
      expect(managedElsewhere({ provider, providerCapabilities: {} } as never)).toBe(false);
    }
  });

  it('shows managed-elsewhere for the external provider, read from its capabilities', () => {
    expect(managedElsewhere({ provider: 'external', providerCapabilities: { checkout: false } } as never)).toBe(true);
  });

  it('decides from capabilities alone: an inbound-only provider under any name is managed elsewhere', () => {
    expect(managedElsewhere({ provider: 'chargebee', providerCapabilities: { checkout: false } } as never)).toBe(true);
    // And a provider NAMED external that the server says can host checkout is not.
    expect(managedElsewhere({ provider: 'external', providerCapabilities: { checkout: true } } as never)).toBe(false);
  });

  it('with no subscription, no provider, or no capabilities, nothing is managed elsewhere', () => {
    expect(managedElsewhere(null)).toBe(false);
    expect(managedElsewhere(undefined)).toBe(false);
    expect(managedElsewhere({ providerCapabilities: null })).toBe(false);
    expect(managedElsewhere({})).toBe(false);
  });
});

describe('resolveCheckoutProvider', () => {
  const offered: ProviderInfo[] = [hosted('stripe'), hosted('paypal'), hosted('razorpay')];

  it('forwards each of the three hosted providers unchanged', () => {
    for (const p of ['stripe', 'paypal', 'razorpay']) {
      expect(resolveCheckoutProvider(p, offered)).toEqual({ kind: 'provider', provider: p });
    }
  });

  it('a pre-capabilities server entry (no `capabilities`) is still a checkout provider', () => {
    expect(isCheckoutProvider({ provider: 'stripe' })).toBe(true);
    expect(resolveCheckoutProvider('stripe', [{ provider: 'stripe' }])).toEqual({ kind: 'provider', provider: 'stripe' });
  });

  it('no pick leaves routing to the server', () => {
    expect(resolveCheckoutProvider('', offered)).toEqual({ kind: 'auto' });
  });

  it('accepts a fifth provider the Application offers with checkout: true', () => {
    const withFifth = [...offered, hosted('mollie')];
    expect(resolveCheckoutProvider('mollie', withFifth)).toEqual({ kind: 'provider', provider: 'mollie' });
  });

  it('refuses, not drops, a provider that cannot host a checkout', () => {
    const withInbound = [...offered, { provider: 'mollie', capabilities: { checkout: false } }];
    expect(resolveCheckoutProvider('mollie', withInbound)).toEqual({
      kind: 'refused',
      code: 'BILLING_PROVIDER_INBOUND_ONLY',
    });
  });

  it('refuses, not drops, a provider the Application does not offer', () => {
    expect(resolveCheckoutProvider('external', offered)).toEqual({
      kind: 'refused',
      code: 'BILLING_PROVIDER_NOT_AVAILABLE',
    });
    expect(resolveCheckoutProvider('mollie', offered)).toEqual({
      kind: 'refused',
      code: 'BILLING_PROVIDER_NOT_AVAILABLE',
    });
  });
});
