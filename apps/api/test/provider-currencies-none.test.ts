/**
 * An empty provider currency list means none, everywhere: routing, the
 * catalogue, the routing preview and readiness. A row saved without a list
 * starts with what its provider usually charges, so only an operator's own
 * empty list takes a provider out of every checkout.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { canCharge } from '../src/modules/billing/credentials.service.js';
import { getModule } from '../src/modules/billing/providers/registry.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const PAYPAL = { clientId: 'paypal_client_ci', clientSecret: 'paypal_secret_ci', webhookId: 'WH-CI' };

type CredentialRow = { provider: string; enabled: boolean; currencies: string[] };
type ReadinessCheck = { id: string; provider: string | null; status: string; message: string; fix: string | null };

describe('an empty provider currency list means none', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    w = await twoCurrencyWorld(app);
  });

  const currenciesOnTheWire = async (provider: string): Promise<string[] | undefined> => {
    const res = await w.operator('GET', '/billing-credentials');
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data as CredentialRow[]).find((row) => row.provider === provider)?.currencies;
  };
  const save = async (method: 'PUT' | 'PATCH', provider: string, body: Record<string, unknown>): Promise<void> => {
    const res = await w.operator(method, `/billing-credentials/${provider}`, body);
    expect(res.statusCode, res.body).toBe(200);
  };

  describe('canCharge', () => {
    it('charges nothing with an empty list, and only what is listed otherwise', () => {
      expect(canCharge({ currencies: [] }, 'USD')).toBe(false);
      expect(canCharge({ currencies: ['USD'] }, 'usd')).toBe(true);
      expect(canCharge({ currencies: ['USD'] }, 'EUR')).toBe(false);
    });
  });

  describe('a provider saved without a list', () => {
    it('is stored with them, keeps its list on a later save without one, and keeps an empty list an operator sends', async () => {
      await save('PUT', 'paypal', { data: PAYPAL, mode: 'test' });
      const preselected = getModule('paypal')!.display.preselectedCurrencies;
      expect(await currenciesOnTheWire('paypal')).toEqual(preselected);

      await save('PATCH', 'paypal', { currencies: ['USD'] });
      await save('PUT', 'paypal', { data: PAYPAL, mode: 'test' });
      expect(await currenciesOnTheWire('paypal')).toEqual(['USD']);

      await save('PATCH', 'paypal', { currencies: [] });
      expect(await currenciesOnTheWire('paypal')).toEqual([]);
      await save('PUT', 'paypal', { data: PAYPAL, mode: 'test' });
      expect(await currenciesOnTheWire('paypal')).toEqual([]);
    });

  });

  describe('a provider left with no currency', () => {
    beforeEach(async () => {
      await save('PATCH', 'stripe', { currencies: [] });
    });

    it('is sent no checkout: the default price has nobody to charge it', async () => {
      const res = await w.checkout({ country: 'US' });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe('BILLING_NO_PROVIDER_FOR_CURRENCY');
    });

    it('makes the plan a readiness blocker on the operator plan list', async () => {
      const res = await w.operator('GET', '/plans');
      expect(res.statusCode, res.body).toBe(200);
      const pro = (res.json().data as { items: Array<{ slug: string; checkout: { ready: boolean; blockers: Array<{ code: string }> } }> }).items.find(
        (plan) => plan.slug === 'pro',
      );
      expect(pro!.checkout.ready).toBe(false);
      expect(pro!.checkout.blockers.map((blocker) => blocker.code)).toContain('PLAN_CURRENCY_UNSUPPORTED');
    });

    it('is refused in the routing preview with the error checkout answers with', async () => {
      const res = await w.operator('POST', '/billing/checkout/preview', { country: 'US', plan: 'pro' });
      expect(res.statusCode, res.body).toBe(200);
      const item = (res.json().data as { items: Array<{ provider: string | null; refusal: { code: string } | null }> }).items[0]!;
      expect(item.provider).toBeNull();
      expect(item.refusal?.code).toBe('BILLING_NO_PROVIDER_FOR_CURRENCY');
    });

    it('is a readiness warning that names the provider and the fix, and no warning once a currency is ticked', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 502 }));
      const providerChecks = async (): Promise<ReadinessCheck[]> => {
        const res = await w.operator('GET', '/checkout/readiness');
        expect(res.statusCode, res.body).toBe(200);
        return (res.json().data as { test: ReadinessCheck[] }).test.filter((check) => check.id === 'provider');
      };
      const stripe = (await providerChecks()).find((check) => check.provider === 'stripe');
      expect(stripe).toMatchObject({
        status: 'WARN',
        message: 'Stripe has no currency ticked, so it is not used for any checkout.',
      });
      expect(stripe!.fix).toContain('Providers → Stripe → Edit');
      expect((await providerChecks()).find((check) => check.provider === 'razorpay')!.message).not.toContain('no currency ticked');

      await save('PATCH', 'stripe', { currencies: ['USD'] });
      // A run is reused for ten seconds; age it so the next read runs again.
      await prisma.application.update({ where: { id: w.applicationId }, data: { checkoutReadinessAt: new Date(Date.now() - 60_000) } });
      expect((await providerChecks()).find((check) => check.provider === 'stripe')!.message).not.toContain('no currency ticked');
    });
  });
});
