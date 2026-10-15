/**
 * `pickProvider` + `resolveBuyerCountry`, the geo router that decides which
 * payment processor receives the money.
 *
 * 47 lines with no test reference anywhere in the suite. A bug here does not
 * throw or log: it sends a checkout to the wrong processor, or refuses a sale
 * that should have gone through. Both are silent revenue outcomes.
 *
 * These call the real implementations. `test/setup.ts` mocks the sibling
 * `getProviderForApplication` (so nothing dials Stripe) but spreads the real
 * module for everything else, routing logic is under test, the network call
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
import type { FastifyRequest } from 'fastify';
import { resolveBuyerCountry } from '../src/modules/billing/buyer-country.js';
import { prisma } from '../src/lib/prisma.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';
import {
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
  external: { webhookSecret: 'ext_whsec_router' },
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
    options: { countries?: string[]; currencies?: string[]; priority?: number; enabled?: boolean },
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

  // ---------- the routing table ----------

  it('a country-specific match beats a lower-priority global', async () => {
    await configure('stripe', { countries: [], priority: 1 });
    await configure('razorpay', { countries: ['IN'], priority: 100 });

    // Priority says stripe; the country list says razorpay. Country wins.
    await expect(pickProvider({ application, country: 'IN' })).resolves.toBe('razorpay');
    // And for any other country, the global takes over again.
    await expect(pickProvider({ application, country: 'DE' })).resolves.toBe('stripe');
  });

  it('breaks equal priorities the same way whatever order the rows were saved in', async () => {
    // PayPal's built-in order is after Stripe's and Razorpay's, which tie and
    // fall to the name.
    for (const order of [['paypal', 'stripe', 'razorpay'], ['stripe', 'razorpay', 'paypal']] as const) {
      await prisma.billingCredentials.deleteMany({ where: { applicationId: application.id } });
      for (const provider of order) await configure(provider, {});
      await expect(pickProvider({ application })).resolves.toBe('razorpay');
      await prisma.billingCredentials.deleteMany({ where: { applicationId: application.id, provider: 'razorpay' } });
      await expect(pickProvider({ application, country: 'IN' })).resolves.toBe('stripe');
    }
  });

  // ---------- currency: the one hard rule ----------

  it('never routes a plan to a provider whose account cannot charge its currency', async () => {
    await configure('razorpay', { countries: ['IN'], currencies: ['inr'], priority: 1 });
    await configure('paypal', { currencies: ['USD', 'EUR'], priority: 50 });

    // The country says Razorpay; a USD plan cannot be charged there.
    await expect(pickProvider({ application, country: 'IN', currency: 'USD' })).resolves.toBe('paypal');
    await expect(pickProvider({ application, country: 'IN', currency: 'INR' })).resolves.toBe('razorpay');
    // And PayPal has no INR, wherever the buyer is.
    await expect(pickProvider({ application, country: 'US', currency: 'inr' })).resolves.toBe('razorpay');
    // Without a currency the rule does not apply.
    await expect(pickProvider({ application, country: 'IN' })).resolves.toBe('razorpay');
  });

  it('refuses a named provider that cannot charge the currency, and names the fix', async () => {
    await configure('razorpay', { currencies: ['INR'] });
    await configure('stripe', { priority: 1 });
    await expect(pickProvider({ application, preferred: 'razorpay', currency: 'USD' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'BILLING_PROVIDER_CURRENCY_UNSUPPORTED',
      fix: expect.stringContaining("add USD to the provider's currencies"),
    });
    // The country's own default is what a picker preselects for every plan,
    // so naming it is no choice: the sale goes to a provider that can charge.
    await prisma.billingCredentials.update({
      where: { applicationId_provider: { applicationId: application.id, provider: 'razorpay' } },
      data: { countries: ['IN'] },
    });
    await expect(pickProvider({ application, country: 'IN', preferred: 'razorpay', currency: 'USD' })).resolves.toBe('stripe');
    // A buyer already bound to that provider is told so, in their own terms.
    await expect(pickProvider({ application, country: 'IN', preferred: 'razorpay', bound: true, currency: 'USD' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_BOUND_PROVIDER_CURRENCY_UNSUPPORTED',
      fix: expect.stringContaining("Contact the application's support"),
    });
    // A provider that is simply not configured keeps its own refusal.
    await expect(pickProvider({ application, preferred: 'paypal', currency: 'USD' })).rejects.toMatchObject({
      code: 'BILLING_PROVIDER_NOT_AVAILABLE',
    });
  });

  it('refuses when no enabled provider can charge the currency', async () => {
    await configure('razorpay', { currencies: ['INR'] });
    await expect(pickProvider({ application, currency: 'USD' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'BILLING_NO_PROVIDER_FOR_CURRENCY',
      message: expect.stringContaining('USD'),
    });
  });

  it('a country with no match falls back to the global provider', async () => {
    await configure('razorpay', { countries: ['IN'], priority: 1 });
    await configure('stripe', { countries: [], priority: 99 });
    // Priority 1 vs 99, but razorpay is India-only and the buyer is not in
    // India, so the global is correct even though it sorts last.
    await expect(pickProvider({ application, country: 'BR' })).resolves.toBe('stripe');
  });

  it('a disabled provider is skipped even when its country matches', async () => {
    await configure('razorpay', { countries: ['IN'], priority: 1, enabled: false });
    await configure('stripe', { countries: [], priority: 100 });
    await expect(pickProvider({ application, country: 'IN' })).resolves.toBe('stripe');
  });
});

describe('resolveBuyerCountry', () => {
  type Shape = { authKind: 'secret' | 'publishable'; visitorCountry?: string | null; internalCaller?: boolean; headers?: Record<string, string | string[]> };
  const request = (shape: Shape): FastifyRequest =>
    ({ visitorCountry: null, internalCaller: false, headers: {}, ...shape }) as unknown as FastifyRequest;

  describe('the country an SDK forwards from the operator\'s platform header', () => {
    const hint = (code: string | string[]) => ({ 'x-rekey-visitor-country-hint': code });

    it('routes a secret-key caller as a hint, never as a declared country', () => {
      expect(resolveBuyerCountry(request({ authKind: 'secret', headers: hint('in') }))).toEqual({ country: 'IN', source: 'hint' });
    });

    it('loses to a country the operator\'s code declared', () => {
      expect(resolveBuyerCountry(request({ authKind: 'secret', headers: hint('IN') }), 'US')).toEqual({ country: 'US', source: 'declared' });
    });

    it('is ignored from a publishable-key caller, who can write any header', () => {
      expect(resolveBuyerCountry(request({ authKind: 'publishable', headers: hint('IN') }))).toBeNull();
      expect(resolveBuyerCountry(request({ authKind: 'publishable', headers: hint('IN') }), 'US')).toEqual({ country: 'US', source: 'hint' });
    });

  });

  it('prefers a vouched country over what a browser caller says', () => {
    expect(resolveBuyerCountry(request({ authKind: 'publishable', visitorCountry: 'IN' }), 'US')).toEqual({ country: 'IN', source: 'vouched' });
  });

  it('treats a browser caller\'s own word, and an unverified CDN header, as a hint', () => {
    expect(resolveBuyerCountry(request({ authKind: 'publishable' }), 'IN')).toEqual({ country: 'IN', source: 'hint' });
    expect(resolveBuyerCountry(request({ authKind: 'publishable', headers: { 'cf-ipcountry': 'de' } }))).toEqual({ country: 'DE', source: 'hint' });
    expect(resolveBuyerCountry(request({ authKind: 'publishable', headers: { 'x-vercel-ip-country': ['FR', 'US'] } }))).toEqual({ country: 'FR', source: 'hint' });
    // A browser can always set its own word; it cannot set the CDN's header.
    expect(resolveBuyerCountry(request({ authKind: 'publishable', headers: { 'cf-ipcountry': 'DE' } }), 'IN')).toEqual({ country: 'DE', source: 'hint' });
  });

  it('never routes a portal buyer by the portal host\'s own country', () => {
    const fromPortal = request({ authKind: 'publishable', internalCaller: true, headers: { 'cf-ipcountry': 'DE' } });
    expect(resolveBuyerCountry(fromPortal)).toBeNull();
    expect(resolveBuyerCountry(request({ authKind: 'publishable', internalCaller: true, visitorCountry: 'IN', headers: { 'cf-ipcountry': 'DE' } }))).toEqual({
      country: 'IN',
      source: 'vouched',
    });
  });

  it('rejects Cloudflare\'s unknown and Tor codes, and anything that is not two letters', () => {
    for (const bad of ['XX', 'T1', 'xx', 'DEU', 'D', '1!', '']) {
      expect(resolveBuyerCountry(request({ authKind: 'publishable', headers: { 'cf-ipcountry': bad } }))).toBeNull();
      expect(resolveBuyerCountry(request({ authKind: 'secret' }), bad)).toBeNull();
    }
  });
});
