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
  type EnabledProvider,
  type PaypalCredentials,
  type RazorpayCredentials,
  type StripeCredentials,
  canCharge,
  providerSupportsCurrency,
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
    fix: `Store the ${provider} API keys in Panel → Application → Billing → Setup → Providers (/applications/${application.id}/billing/providers). A non-production Application takes the provider's sandbox/test keys; a PRODUCTION one takes live keys.`,
  });
}

function isCheckoutCapable(provider: BillingProviderName): boolean {
  return getModule(provider)?.capabilities.checkout !== false;
}

function inboundOnly(
  application: { id: string },
  provider: BillingProviderName,
  hostedProviderEnabled: boolean,
): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'BILLING_PROVIDER_INBOUND_ONLY',
    details: { provider },
    message: `Provider "${provider}" only receives events from an external billing system; it cannot host a checkout.`,
    fix: hostedProviderEnabled
      ? 'Omit `provider` to let the router pick a hosted provider, or sell through the external system.'
      : `Sell through the external billing system, which posts subscription events to Rekey, or connect a hosted payment provider in Panel → Application → Billing → Setup → Providers (/applications/${application.id}/billing/providers).`,
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
 * Application and the end-user's ISO 3166-1 alpha-2 country code (from
 * `resolveBuyerCountry`), pick the best provider.
 *
 * Algorithm:
 *   1. Filter to providers where `enabled = true`.
 *   2. Among those, prefer ones whose `countries` list contains `country`
 *      (country-specific match wins over global fallback).
 *   3. Within the matching set, pick the one with the lowest `priority`. Equal
 *      priorities fall to the module's default order, then the provider name.
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
  /**
   * The currency the checkout will charge. A provider whose account cannot
   * charge it is never picked, and naming one is refused: this is the one
   * hard rule in routing, so it binds the named provider too.
   */
  currency?: string | undefined;
  /** `preferred` is the provider this buyer is already bound to, not a choice made for this checkout. */
  bound?: boolean | undefined;
  /** `listCheckoutEnabled` for this Application and country, when the caller has already read it. */
  configured?: readonly EnabledProvider[] | undefined;
}): Promise<BillingProviderName> {
  // Checkout-capable only. An inbound-only provider is enabled so that its
  // webhooks verify, not so that buyers are sent to it.
  const configured =
    args.configured ?? (await billingCredentialsService.listCheckoutEnabled(args.application.id, args.country));
  const currency = args.currency;
  const enabled = currency === undefined ? configured : configured.filter((p) => canCharge(p, currency));
  const where = `Panel → Application → Billing → Setup → Providers (/applications/${args.application.id}/billing/providers)`;

  const namedCannotCharge =
    args.preferred !== undefined &&
    currency !== undefined &&
    configured.some((p) => p.provider === args.preferred) &&
    !enabled.some((p) => p.provider === args.preferred);
  // A picker preselects the provider routing would pick for the buyer's
  // country and posts it for whatever plan is bought. Naming that same
  // default is no choice at all, so it routes by currency instead of failing
  // a sale the router could have placed. Any other named provider, and a
  // provider the buyer is bound to, is refused.
  const preferred =
    namedCannotCharge && args.bound !== true && configured[0]?.provider === args.preferred && enabled.length > 0
      ? undefined
      : args.preferred;

  if (preferred !== undefined && namedCannotCharge) {
    const code = currency.toUpperCase();
    // A provider that cannot charge the currency at all is not repaired by
    // adding the currency to its list: the save would be refused.
    const repairable = providerSupportsCurrency(preferred, code);
    if (args.bound === true) {
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_BOUND_PROVIDER_CURRENCY_UNSUPPORTED',
        message: `This plan is priced in ${code}, and your existing billing here runs through a payment provider that cannot charge it.`,
        fix: `Contact the application's support to buy this plan. For the operator: ${repairable ? `add ${code} to "${preferred}"'s currencies in ${where}, or offer` : `"${preferred}" cannot charge ${code} at all, so offer`} this plan in a currency it charges.`,
      });
    }
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_PROVIDER_CURRENCY_UNSUPPORTED',
      message: `This Application's "${preferred}" account ${repairable ? 'is not set up to charge' : 'cannot charge'} ${code}, the currency of this plan.`,
      fix: repairable
        ? `Omit \`provider\` to let Rekey pick one that can, or add ${code} to the provider's currencies in ${where}.`
        : `Omit \`provider\` to let Rekey pick one that can. "${preferred}" cannot charge ${code} at all.`,
    });
  }
  const namedIsConfigured = preferred === undefined || configured.some((p) => p.provider === preferred);
  if (currency !== undefined && configured.length > 0 && enabled.length === 0 && namedIsConfigured) {
    const code = currency.toUpperCase();
    const skipped = configured.filter((p) => p.unsupportedCurrencies.includes(code)).map((p) => `"${p.provider}"`);
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_NO_PROVIDER_FOR_CURRENCY',
      message:
        `No enabled provider is set up to charge ${code}, the currency of this plan.` +
        (skipped.length === 0
          ? ''
          : ` ${skipped.join(' and ')} ${skipped.length === 1 ? 'lists' : 'list'} ${code} but cannot charge it at all, so ${skipped.length === 1 ? 'it was' : 'they were'} skipped.`),
      fix: `Add ${code} to the currencies of a provider that can charge it in ${where}, or price the plan in a currency a provider there can charge.`,
    });
  }

  // Explicit user pick wins, if it's actually configured + enabled. Decided
  // before the "nothing enabled" refusal, so a caller who named a provider is
  // told about that provider and not about the Application's default.
  if (preferred) {
    const match = enabled.find((p) => p.provider === preferred);
    if (match) return match.provider;
    if (!isCheckoutCapable(preferred)) {
      throw inboundOnly(args.application, preferred, enabled.length > 0);
    }
    if (enabled.length === 0) throw credentialsNotConfigured(args.application, preferred);
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_PROVIDER_NOT_AVAILABLE',
      message: `Requested provider "${preferred}" is not configured or is disabled for this Application.`,
      fix: 'Pass a different provider, or omit `provider` to let the system pick.',
    });
  }

  if (enabled.length === 0) {
    // An inbound-only provider has credentials; it just cannot take a buyer.
    // Saying it has none sent operators to re-enter keys that were fine.
    const inbound = (await billingCredentialsService.listEnabled(args.application.id)).find(
      (p) => !isCheckoutCapable(p.provider),
    );
    if (inbound) throw inboundOnly(args.application, inbound.provider, false);
    // No enabled credentials at all. This used to fall through to the legacy
    // `billingConfig.provider` hint and land on the Stripe stub, which made an
    // unconfigured app look like a working one. Refuse instead.
    const cfg = args.application.billingConfig as { provider?: BillingProviderName } | null;
    throw credentialsNotConfigured(args.application, cfg?.provider ?? 'stripe');
  }

  // `listCheckoutEnabled` returns the routing order itself: country matches,
  // then global providers, then the rest, each by priority and then by name.
  // The public provider list is the same call, so its first entry is the
  // provider a checkout is routed to, for a buyer not already bound to one.
  return enabled[0]!.provider;
}

export type { BillingProvider } from './types.js';
