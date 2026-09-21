/**
 * Provider registry. Builds a `BillingProvider` instance for a given
 * (Application, providerName) tuple, decrypting that application's BYO
 * credentials and threading them into the provider class.
 *
 * Multi-provider model (phase 6+): an Application can configure any subset
 * of {stripe, paypal, razorpay}. The caller decides which provider to use,
 * either explicitly (user picked at checkout) or via the geo router
 * (`pickProvider`), then passes that name here.
 *
 * **Every provider returned from here talks to a real payment processor.**
 * There is no fallback. Missing credentials throw
 * `BILLING_CREDENTIALS_NOT_CONFIGURED` in every environment, dev included:
 * the old behaviour, hand back a deterministic stub so the wiring "worked",
 * meant an operator could run a whole integration, see checkout URLs and
 * ACTIVE subscriptions, and never learn that no money could ever move. A
 * billing system that succeeds when it is not configured is worse than one
 * that refuses to start. Tests get their fakes from `test/fakes/`.
 */

import type { Application } from '@prisma/client';
import { RekeyError } from '../../../lib/error.js';
import { RealStripeProvider } from './stripe-real.js';
import { RealPaypalProvider } from './paypal.js';
import { RealRazorpayProvider } from './razorpay.js';
import { ExternalBillingProvider } from './external.js';
import { getModule } from './registry.js';
import {
  billingCredentialsService,
  type BillingProviderName,
  type PaypalCredentials,
  type RazorpayCredentials,
  type StripeCredentials,
} from '../credentials.service.js';
import type { BillingProvider } from './types.js';

/** The one refusal for "this Application has no usable credentials". */
export function credentialsNotConfigured(
  application: { id: string },
  provider: BillingProviderName,
): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
    message: `Billing provider "${provider}" has no credentials configured for this Application.`,
    fix: `Store the ${provider} API keys in Panel → Application → Billing (/applications/${application.id}/billing). A non-production Application takes the provider's sandbox/test keys; a PRODUCTION one takes live keys.`,
  });
}

export async function getProviderForApplication(
  application: Application,
  provider: BillingProviderName,
): Promise<BillingProvider> {
  switch (provider) {
    case 'stripe': {
      const creds = await billingCredentialsService.loadDecrypted(application.id, 'stripe');
      if (!creds) throw credentialsNotConfigured(application, 'stripe');
      return new RealStripeProvider(creds as StripeCredentials);
    }
    case 'paypal': {
      const row = await billingCredentialsService.loadDecryptedWithMode(application.id, 'paypal');
      if (!row) throw credentialsNotConfigured(application, 'paypal');
      return new RealPaypalProvider(row.data as PaypalCredentials, row.mode);
    }
    case 'razorpay': {
      const creds = await billingCredentialsService.loadDecrypted(application.id, 'razorpay');
      if (!creds) throw credentialsNotConfigured(application, 'razorpay');
      return new RealRazorpayProvider(creds as RazorpayCredentials);
    }
    case 'external': {
      // Every outbound call on this provider refuses with a named error (see
      // external.ts), what a row stamped `provider: 'external'` should get
      // when a checkout or cancellation path reaches for its processor.
      //
      // The one exception is READING. Credentials are loaded so the
      // subscription import can pull the book of business the event feed never
      // saw. Absent or partial credentials are NOT an error here: the provider
      // is built without a pull config, `listSubscriptions` then refuses with
      // EXTERNAL_PULL_NOT_CONFIGURED, and every other path behaves exactly as
      // it did before.
      const creds = (await billingCredentialsService
        .loadDecrypted(application.id, 'external')
        .catch(() => null)) as Record<string, string> | null;
      const url = creds?.subscriptionsUrl;
      const token = creds?.pullToken;
      const secret = creds?.webhookSecret;
      return new ExternalBillingProvider(
        url && token && secret
          ? { subscriptionsUrl: url, token, signingSecret: secret }
          : undefined,
      );
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
 *   5. Still nothing (every configured provider has a country list and none
 *      match)? Route to any enabled provider, lowest priority. Better to reach
 *      *a* processor than to fail the money path on a geo miss. The only
 *      refusals are "no enabled credentials at all" and an explicitly
 *      `preferred` provider that isn't configured.
 *
 * **There is NO ambient per-provider default.** This function names no provider
 * and consults no country table, it reads only the stored `countries` /
 * `priority` on each credential row, which `upsertRaw` defaults to `[]` and
 * `100`. A module's `display.defaultCountries` / `display.priority` are
 * *advertised* through the discovery projection in `registry.ts` so the panel can
 * pre-fill the form; nothing copies them onto a row. An operator who never sets
 * countries gets "lowest priority wins", not "Razorpay in India".
 */
export async function pickProvider(args: {
  application: Application;
  country?: string | undefined;
  preferred?: BillingProviderName | undefined;
}): Promise<BillingProviderName> {
  // Checkout-capable only. An inbound-only provider is enabled so that its
  // webhooks verify, not so that buyers are sent to it.
  const enabled = await billingCredentialsService.listCheckoutEnabled(args.application.id);
  if (enabled.length === 0) {
    // No enabled credentials at all. This used to fall through to the legacy
    // `billingConfig.provider` hint and land on the Stripe stub, which made an
    // unconfigured app look like a working one. Refuse instead.
    const cfg = args.application.billingConfig as { provider?: BillingProviderName } | null;
    throw credentialsNotConfigured(args.application, cfg?.provider ?? 'stripe');
  }

  // Explicit user pick wins, if it's actually configured + enabled.
  if (args.preferred) {
    const match = enabled.find((p) => p.provider === args.preferred);
    if (match) return match.provider;
    if (getModule(args.preferred)?.capabilities.checkout === false) {
      throw new RekeyError({
        statusCode: 400,
        code: 'BILLING_PROVIDER_INBOUND_ONLY',
        message: `Provider "${args.preferred}" only receives events from an external billing system; it cannot host a checkout.`,
        fix: 'Omit `provider` to let the router pick a hosted provider, or sell through the external system.',
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
  // every configured provider has a country list and none match, better to
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
