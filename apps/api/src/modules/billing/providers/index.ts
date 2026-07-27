/**
 * Provider registry. Builds a `BillingProvider` instance for a given
 * (Application, providerName) tuple, decrypting that application's BYO
 * credentials and threading them into the provider class.
 *
 * Multi-provider model (phase 6+): an Application can configure any subset
 * of {stripe, paypal, razorpay}. The caller decides which provider to use
 * — either explicitly (user picked at checkout) or via the geo router
 * (`pickProvider`), then passes that name here.
 *
 * Single chokepoint — no other code should `new StripeStubProvider()`
 * directly.
 */

import type { Application } from '@prisma/client';
import { RekeyError } from '../../../lib/error.js';
import { StripeStubProvider } from './stripe.js';
import { RealStripeProvider } from './stripe-real.js';
import { PaypalStubProvider, RealPaypalProvider } from './paypal.js';
import { RazorpayStubProvider, RealRazorpayProvider } from './razorpay.js';
import {
  billingCredentialsService,
  type BillingProviderName,
  type PaypalCredentials,
  type RazorpayCredentials,
  type StripeCredentials,
} from '../credentials.service.js';
import type { BillingProvider } from './types.js';

export async function getProviderForApplication(
  application: Application,
  provider: BillingProviderName,
): Promise<BillingProvider> {
  switch (provider) {
    case 'stripe': {
      const creds = await billingCredentialsService.loadDecrypted(application.id, 'stripe');
      // No BYO creds → stub. Useful in dev/CI where the operator hasn't
      // wired Stripe yet. The per-app webhook endpoint refuses with
      // BILLING_CREDENTIALS_NOT_CONFIGURED, which is the right UX.
      if (!creds) return new StripeStubProvider(null);
      // Tests + explicit `RELIPAY_BILLING_FORCE_STUB=true` short-circuit the
      // real SDK so we don't hit the network. Production uses the real SDK
      // unconditionally as long as creds exist.
      if (process.env.NODE_ENV === 'test' || process.env.RELIPAY_BILLING_FORCE_STUB === 'true') {
        return new StripeStubProvider(creds as StripeCredentials);
      }
      return new RealStripeProvider(creds as StripeCredentials);
    }
    case 'paypal': {
      const row = await billingCredentialsService.loadDecryptedWithMode(application.id, 'paypal');
      if (!row) {
        throw new RekeyError({
          statusCode: 400,
          code: 'BILLING_PROVIDER_NOT_CONFIGURED',
          message: `Billing provider "paypal" is not configured for this Application.`,
          fix: `Configure it in the panel at /applications/${application.id}/billing.`,
        });
      }
      if (process.env.NODE_ENV === 'test' || process.env.RELIPAY_BILLING_FORCE_STUB === 'true') {
        return new PaypalStubProvider();
      }
      return new RealPaypalProvider(row.data as PaypalCredentials, row.mode);
    }
    case 'razorpay': {
      const creds = await billingCredentialsService.loadDecrypted(application.id, 'razorpay');
      if (!creds) {
        throw new RekeyError({
          statusCode: 400,
          code: 'BILLING_PROVIDER_NOT_CONFIGURED',
          message: `Billing provider "razorpay" is not configured for this Application.`,
          fix: `Configure it in the panel at /applications/${application.id}/billing.`,
        });
      }
      if (process.env.NODE_ENV === 'test' || process.env.RELIPAY_BILLING_FORCE_STUB === 'true') {
        return new RazorpayStubProvider();
      }
      return new RealRazorpayProvider(creds as RazorpayCredentials);
    }
  }
}

/**
 * Geo-aware provider picker. Given the configured providers for an
 * Application and the end-user's ISO 3166-1 alpha-2 country code (best-effort
 * from request headers), pick the best provider.
 *
 * Algorithm:
 *   1. Filter to providers where `enabled = true`.
 *   2. Among those, prefer ones whose `countries` list contains `country`
 *      (country-specific match wins over global fallback).
 *   3. Within the matching set, pick the one with the lowest `priority`.
 *   4. If no country match, fall back to providers with empty `countries[]`
 *      (treated as "global / any country") at lowest priority.
 *   5. If nothing matches, throw — caller should surface the error.
 *
 * Sane default policy when nothing is configured explicitly:
 *   - India (IN) → razorpay if available
 *   - everywhere → stripe if available, else paypal
 *
 * That default lives in the *list* (a tenant doesn't have to set countries
 * to get sensible behavior — pickProvider handles the ambient case).
 */
export async function pickProvider(args: {
  application: Application;
  country?: string | undefined;
  preferred?: BillingProviderName | undefined;
  /**
   * Test/live isolation (roadmap §7): the calling secret key's mode. A TEST
   * request only ever selects credentials stored with `mode: 'test'` —
   * a sandbox/dev provider account — and refuses with BILLING_MODE_MISMATCH
   * when only live credentials exist. LIVE requests keep the historical
   * behavior (any enabled credentials) so existing single-mode apps see zero
   * change.
   */
  dataMode?: import('@prisma/client').DataMode | undefined;
}): Promise<BillingProviderName> {
  const allEnabled = await billingCredentialsService.listEnabled(args.application.id);
  if (allEnabled.length === 0) {
    // Legacy fallback — no billing_credentials row exists yet (fresh app or
    // dev/CI without BYO creds). Honor the legacy single-provider hint on
    // `billingConfig.provider`, which is 'stripe' by default. The
    // StripeStubProvider takes over and the operator gets a clear webhook
    // error if they actually try to charge anything.
    const cfg = args.application.billingConfig as { provider?: BillingProviderName } | null;
    return cfg?.provider ?? 'stripe';
  }

  const requireTestCreds = args.dataMode === 'TEST';
  const enabled = requireTestCreds ? allEnabled.filter((p) => p.mode === 'test') : allEnabled;
  if (requireTestCreds && enabled.length === 0) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_MODE_MISMATCH',
      message:
        'This checkout was started with a test-mode secret key, but every configured billing ' +
        'provider holds live credentials. Test checkouts must use a sandbox provider account.',
      fix: 'Add sandbox/test credentials (mode: test) for a provider in Panel → Application → Billing, or use a live key.',
    });
  }

  // Explicit user pick wins, if it's actually configured + enabled.
  if (args.preferred) {
    const match = enabled.find((p) => p.provider === args.preferred);
    if (match) return match.provider;
    if (requireTestCreds && allEnabled.some((p) => p.provider === args.preferred)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'BILLING_MODE_MISMATCH',
        message:
          `Provider "${args.preferred}" is configured with live credentials, but this checkout ` +
          'was started with a test-mode secret key.',
        fix: `Store sandbox credentials for "${args.preferred}" (mode: test), or use a live key.`,
      });
    }
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_PROVIDER_NOT_AVAILABLE',
      message: `Requested provider "${args.preferred}" is not configured or is disabled for this Application.`,
      fix: 'Pass a different provider, or omit `provider` to let the system pick.',
    });
  }

  const country = args.country?.toUpperCase();

  // Country-specific candidates.
  if (country) {
    const countryHits = enabled
      .filter((p) => p.countries.includes(country))
      .sort((a, b) => a.priority - b.priority);
    if (countryHits.length > 0) return countryHits[0]!.provider;
  }

  // Global / fallback candidates (no country restriction).
  const globals = enabled
    .filter((p) => p.countries.length === 0)
    .sort((a, b) => a.priority - b.priority);
  if (globals.length > 0) return globals[0]!.provider;

  // Last resort: any enabled provider, lowest priority. (This kicks in when
  // every configured provider has a country list and none match — better to
  // route to *something* than to fail outright.)
  return enabled.sort((a, b) => a.priority - b.priority)[0]!.provider;
}

/**
 * Best-effort country extraction from a Fastify request. Honors
 * Cloudflare's `CF-IPCountry`, Vercel's `x-vercel-ip-country`, and
 * a generic `x-country` header. Returns undefined when nothing is set.
 */
export function countryFromRequest(headers: Record<string, string | string[] | undefined>): string | undefined {
  const pick = (k: string): string | undefined => {
    const v = headers[k.toLowerCase()];
    if (Array.isArray(v)) return v[0];
    return typeof v === 'string' ? v : undefined;
  };
  const raw = pick('cf-ipcountry') ?? pick('x-vercel-ip-country') ?? pick('x-country');
  if (!raw) return undefined;
  const upper = raw.toUpperCase();
  if (upper === 'XX' || upper === 'T1') return undefined; // CF Tor / unknown
  return upper.length === 2 ? upper : undefined;
}

export type { BillingProvider } from './types.js';
