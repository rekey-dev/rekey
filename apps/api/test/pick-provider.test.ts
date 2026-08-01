/**
 * `pickProvider` + `countryFromRequest` — the geo router that decides which
 * payment processor receives the money.
 *
 * 47 lines with no test reference anywhere in the suite. A bug here does not
 * throw or log: it sends a checkout to the wrong processor, or refuses a sale
 * that should have gone through. Both are silent revenue outcomes.
 *
 * These call the real implementations. `test/setup.ts` mocks the sibling
 * `getProviderForApplication` (so nothing dials Stripe) but spreads the real
 * module for everything else — routing logic is under test, the network call
 * is not.
 *
 * The invariant the routing table exists to protect, spelled out in
 * `providers/index.ts`: there is NO ambient per-provider default. Nothing
 * copies a module's advertised `defaultCountries` onto a credential row. An
 * operator who never sets `countries` gets "lowest priority wins", not
 * "Razorpay in India". The last test in the routing block is that claim.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Application } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';
import {
  countryFromRequest,
  pickProvider,
} from '../src/modules/billing/providers/index.js';
import {
  billingCredentialsService,
  type BillingProviderName,
} from '../src/modules/billing/credentials.service.js';

const CREDS: Record<BillingProviderName, Record<string, string>> = {
  stripe: { apiKey: 'sk_test_router', webhookSecret: 'whsec_router' },
  paypal: { clientId: 'pp_router', clientSecret: 'pp_secret', webhookId: 'WH-router' },
  razorpay: { keyId: 'rzp_test_router', keySecret: 'rzp_secret', webhookSecret: 'rzp_whsec' },
};

describe('pickProvider (billing geo router)', () => {
  let application: Application;

  // Rebuilt per test: setup.ts truncates `applications` and
  // `billing_credentials` before each one.
  beforeEach(async () => {
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Router Co',
        ownerEmail: `router-${Math.random().toString(36).slice(2, 10)}@example.com`,
      },
    });
    // Via the service, not a raw insert: it is what mints the publishable key
    // and seeds the role catalog, so the fixture is a real Application.
    application = await applicationsService.create({
      tenantId: tenant.id,
      name: 'Router',
      slug: `router-${Math.random().toString(36).slice(2, 10)}`,
    });
  });

  async function configure(
    provider: BillingProviderName,
    options: { countries?: string[]; priority?: number; enabled?: boolean },
  ): Promise<void> {
    await billingCredentialsService.upsertRaw(application.id, provider, CREDS[provider], {
      mode: 'test',
      enabled: true,
      ...options,
    });
  }

  // ---------- refusals ----------

  it('refuses when the Application has no credentials at all', async () => {
    await expect(pickProvider({ application })).rejects.toMatchObject({
      statusCode: 400,
      code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
    });
  });

  it('refuses when every configured provider is disabled', async () => {
    await configure('stripe', { enabled: false });
    await configure('paypal', { enabled: false });
    // A disabled row is not a usable one. Falling through to it would be the
    // "checkout succeeds against a processor the operator switched off" bug.
    await expect(pickProvider({ application })).rejects.toMatchObject({
      code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
    });
  });

  it('names the legacy billingConfig hint in the refusal when there is one', async () => {
    const hinted = await prisma.application.update({
      where: { id: application.id },
      data: { billingConfig: { provider: 'razorpay' } },
    });
    await expect(pickProvider({ application: hinted })).rejects.toThrow(/razorpay/);
  });

  // ---------- explicit preference ----------

  it('an explicit preference wins over the geo table', async () => {
    await configure('stripe', { priority: 1 });
    await configure('paypal', { countries: ['US'], priority: 50 });

    await expect(
      pickProvider({ application, preferred: 'paypal', country: 'US' }),
    ).resolves.toBe('paypal');
    // ...and over the country match too.
    await expect(
      pickProvider({ application, preferred: 'stripe', country: 'US' }),
    ).resolves.toBe('stripe');
  });

  it('an unconfigured preference is refused, not quietly re-routed', async () => {
    await configure('stripe', {});
    const err = await pickProvider({ application, preferred: 'razorpay' }).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 400, code: 'BILLING_PROVIDER_NOT_AVAILABLE' });
  });

  it('a DISABLED preference is refused the same way', async () => {
    await configure('stripe', {});
    await configure('paypal', { enabled: false });
    await expect(pickProvider({ application, preferred: 'paypal' })).rejects.toMatchObject({
      code: 'BILLING_PROVIDER_NOT_AVAILABLE',
    });
  });

  // ---------- the routing table ----------

  it('a country-specific match beats a lower-priority global', async () => {
    await configure('stripe', { countries: [], priority: 1 });
    await configure('razorpay', { countries: ['IN'], priority: 100 });

    // Priority says stripe; the country list says razorpay. Country wins.
    await expect(pickProvider({ application, country: 'IN' })).resolves.toBe('razorpay');
    // And for any other country, the global takes over again.
    await expect(pickProvider({ application, country: 'DE' })).resolves.toBe('stripe');
  });

  it('within the country matches, the lowest priority wins', async () => {
    await configure('razorpay', { countries: ['IN'], priority: 90 });
    await configure('paypal', { countries: ['IN'], priority: 10 });
    await expect(pickProvider({ application, country: 'IN' })).resolves.toBe('paypal');
  });

  it('the country code is matched case-insensitively', async () => {
    await configure('stripe', { countries: [], priority: 1 });
    await configure('razorpay', { countries: ['IN'], priority: 100 });
    await expect(pickProvider({ application, country: 'in' })).resolves.toBe('razorpay');
  });

  it('with no country at all, the lowest-priority global is used', async () => {
    await configure('paypal', { countries: [], priority: 20 });
    await configure('stripe', { countries: [], priority: 5 });
    await expect(pickProvider({ application })).resolves.toBe('stripe');
  });

  it('a country with no match falls back to the global provider', async () => {
    await configure('razorpay', { countries: ['IN'], priority: 1 });
    await configure('stripe', { countries: [], priority: 99 });
    // Priority 1 vs 99 — but razorpay is India-only and the buyer is not in
    // India, so the global is correct even though it sorts last.
    await expect(pickProvider({ application, country: 'BR' })).resolves.toBe('stripe');
  });

  it('when every provider is country-restricted and none match, it still routes', async () => {
    await configure('razorpay', { countries: ['IN'], priority: 50 });
    await configure('paypal', { countries: ['US'], priority: 10 });
    // Last resort by design: reaching *a* processor beats failing the money
    // path on a geo miss. Lowest priority among the enabled set.
    await expect(pickProvider({ application, country: 'JP' })).resolves.toBe('paypal');
  });

  it('there is no ambient per-provider default — an unset countries[] means global', async () => {
    // Razorpay's module advertises India in its discovery projection. Nothing
    // copies that onto the row, so an operator who never set `countries` gets
    // lowest-priority-wins even for an Indian buyer.
    await configure('razorpay', { priority: 100 });
    await configure('stripe', { priority: 1 });
    await expect(pickProvider({ application, country: 'IN' })).resolves.toBe('stripe');
  });

  it('a disabled provider is skipped even when its country matches', async () => {
    await configure('razorpay', { countries: ['IN'], priority: 1, enabled: false });
    await configure('stripe', { countries: [], priority: 100 });
    await expect(pickProvider({ application, country: 'IN' })).resolves.toBe('stripe');
  });
});

describe('countryFromRequest', () => {
  it('honours Cloudflare, Vercel and the generic header, in that order', () => {
    expect(countryFromRequest({ 'cf-ipcountry': 'DE' })).toBe('DE');
    expect(countryFromRequest({ 'x-vercel-ip-country': 'FR' })).toBe('FR');
    expect(countryFromRequest({ 'x-country': 'IN' })).toBe('IN');
    expect(
      countryFromRequest({ 'cf-ipcountry': 'DE', 'x-vercel-ip-country': 'FR', 'x-country': 'IN' }),
    ).toBe('DE');
    expect(countryFromRequest({ 'x-vercel-ip-country': 'FR', 'x-country': 'IN' })).toBe('FR');
  });

  it('upper-cases and takes the first value of a repeated header', () => {
    expect(countryFromRequest({ 'cf-ipcountry': 'de' })).toBe('DE');
    expect(countryFromRequest({ 'cf-ipcountry': ['GB', 'US'] })).toBe('GB');
  });

  it('treats Cloudflare\'s unknown/Tor sentinels as no country', () => {
    // XX and T1 are placeholders, not countries — routing on them would send
    // every Tor visitor to whichever provider happened to list them.
    expect(countryFromRequest({ 'cf-ipcountry': 'XX' })).toBeUndefined();
    expect(countryFromRequest({ 'cf-ipcountry': 'T1' })).toBeUndefined();
    expect(countryFromRequest({ 'cf-ipcountry': 'xx' })).toBeUndefined();
  });

  it('rejects anything that is not a 2-letter code, and an absent header', () => {
    expect(countryFromRequest({})).toBeUndefined();
    expect(countryFromRequest({ 'cf-ipcountry': 'DEU' })).toBeUndefined();
    expect(countryFromRequest({ 'cf-ipcountry': 'D' })).toBeUndefined();
    expect(countryFromRequest({ 'cf-ipcountry': undefined })).toBeUndefined();
  });
});
