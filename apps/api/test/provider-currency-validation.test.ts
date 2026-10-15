/**
 * The currencies saved for a provider are checked against what that provider
 * publishes, on every route that saves them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('provider currency validation', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await twoCurrencyWorld(app);
  });

  const razorpayCharges = (currencies: string[]) =>
    billingCredentialsService.upsertRaw(
      w.applicationId,
      'razorpay',
      { keyId: 'rzp_test_ci', keySecret: 'secret_ci_only', webhookSecret: 'rzp_whsec_two_currency' },
      { mode: 'test', enabled: true, currencies, countries: ['IN'], priority: 50 },
    );
  describe("a provider's currencies", () => {
    const PAYPAL = { clientId: 'paypal_client_ci', clientSecret: 'paypal_secret_ci', webhookId: 'WH-CI' };
    const stored = async (provider: string) =>
      (await prisma.billingCredentials.findUniqueOrThrow({ where: { applicationId_provider: { applicationId: w.applicationId, provider } } })).currencies;

    it.each([
      ['paypal', 'INR', 'PayPal'],
      ['razorpay', 'ARS', 'Razorpay'],
      ['stripe', 'KWD', 'Stripe'],
      ['stripe', 'BGN', 'Stripe'],
    ])('refuses to save %s with %s, which it cannot charge, naming both', async (provider, code, label) => {
      if (provider === 'paypal') await billingCredentialsService.upsertRaw(w.applicationId, 'paypal', PAYPAL, { mode: 'test', currencies: ['USD'] });
      const before = await stored(provider);

      const patched = await w.operator('PATCH', `/billing-credentials/${provider}`, { enabled: false, currencies: ['usd', code.toLowerCase()] });
      expect(patched.statusCode, patched.body).toBe(400);
      expect(patched.json().error).toMatchObject({ code: 'BILLING_PROVIDER_CURRENCY_NOT_OFFERED' });
      expect(patched.json().error.message).toBe(`${label} ("${provider}") cannot charge ${code}.`);
      expect(patched.json().error.fix).toContain(`Remove ${code} from`);

      const row = await prisma.billingCredentials.findUniqueOrThrow({ where: { applicationId_provider: { applicationId: w.applicationId, provider } } });
      expect(row.currencies).toEqual(before);
      // The refused edit applied nothing else it carried.
      expect(row.enabled).toBe(true);
    });

    it('saves every code a provider publishes', async () => {
      const res = await w.operator('GET', '/billing/providers');
      const providers = (res.json().data as { providers: Array<{ name: string; supportedCurrencies: string[] | 'all-sellable' }> }).providers;
      for (const name of ['stripe', 'razorpay']) {
        const supported = providers.find((p) => p.name === name)!.supportedCurrencies as string[];
        expect(supported.length).toBeGreaterThan(20);
        const saved = await w.operator('PATCH', `/billing-credentials/${name}`, { currencies: supported });
        expect(saved.statusCode, saved.body).toBe(200);
        expect(await stored(name)).toEqual(supported);
      }
    });

    describe('on a row saved before the list was checked', () => {
      beforeEach(async () => {
        await billingCredentialsService.upsertRaw(w.applicationId, 'paypal', PAYPAL, { mode: 'test', currencies: ['USD'], priority: 5 });
        // PayPal holds INR, which it cannot charge, and nothing else charges INR.
        await prisma.billingCredentials.update({
          where: { applicationId_provider: { applicationId: w.applicationId, provider: 'paypal' } },
          data: { currencies: ['INR', 'USD'] },
        });
        await razorpayCharges(['USD']);
      });

      it('shows the operator which codes are unsupported, on both lists', async () => {
        const discovery = await w.operator('GET', '/billing/providers');
        expect(discovery.statusCode, discovery.body).toBe(200);
        const paypal = (discovery.json().data as { providers: Array<{ name: string; status: Record<string, unknown> | null }> }).providers.find((p) => p.name === 'paypal');
        expect(paypal!.status).toMatchObject({ currencies: ['INR', 'USD'], unsupportedCurrencies: ['INR'] });
        const list = await w.operator('GET', '/billing-credentials');
        const rows = list.json().data as Array<{ provider: string; unsupportedCurrencies: string[] }>;
        expect(rows.find((row) => row.provider === 'paypal')!.unsupportedCurrencies).toEqual(['INR']);
        expect(rows.find((row) => row.provider === 'stripe')!.unsupportedCurrencies).toEqual([]);
      });

      it('skips the code at routing: a buyer in India is charged the default price, not sent to PayPal in INR', async () => {
        const { provider, row } = await w.sessionOf(await w.checkout({ country: 'IN' }));
        expect(row.currency).toBe('USD');
        expect(['paypal', 'stripe', 'razorpay']).toContain(provider);
      });

      it('says which provider was skipped when a checkout must be in that currency', async () => {
        const res = await w.checkout({ currency: 'INR', onUnavailableCurrency: 'refuse' });
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().error.code).toBe('BILLING_NO_PROVIDER_FOR_CURRENCY');

        await w.createPlan({ slug: 'rupees', name: 'Rupees', price: { currency: 'INR', amount: 99900 } });
        const onlyInr = await w.checkout({ planSlug: 'rupees' });
        expect(onlyInr.statusCode, onlyInr.body).toBe(400);
        expect(onlyInr.json().error.code).toBe('BILLING_NO_PROVIDER_FOR_CURRENCY');
        expect(onlyInr.json().error.message).toContain('"paypal" lists INR but cannot charge it at all, so it was skipped.');

        const named = await w.checkout({ planSlug: 'rupees', provider: 'paypal' });
        expect(named.statusCode, named.body).toBe(400);
        expect(named.json().error).toMatchObject({ code: 'BILLING_PROVIDER_CURRENCY_UNSUPPORTED' });
        expect(named.json().error.fix).toBe('Omit `provider` to let Rekey pick one that can. "paypal" cannot charge INR at all.');
      });
    });
  });
});
