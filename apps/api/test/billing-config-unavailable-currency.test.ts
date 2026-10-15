/**
 * `billingConfig.onUnavailableCurrency`: the Application's default for a
 * checkout that names a currency nobody can charge. A request that sends its
 * own value wins, and the default decides nothing else. Every answer is read
 * off the HTTP response.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

type LogEntry = { type: string; actor: { type: string; id: string | null }; data: { before: string; after: string } };

describe('the Application default for a currency that cannot be charged', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await twoCurrencyWorld(app);
  });

  const patch = (body: Record<string, unknown>) => w.operator('PATCH', '/billing-config', body);
  const setDefault = async (value: 'fallback' | 'refuse'): Promise<void> => {
    const res = await patch({ onUnavailableCurrency: value });
    expect(res.statusCode, res.body).toBe(200);
  };
  const logged = async (type: string): Promise<LogEntry[]> => {
    const res = await w.operator('GET', `/billing/events?type=${type}&limit=50`);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data as { items: LogEntry[] }).items;
  };
  /** Nobody is left who can charge INR: Razorpay, the one provider that did, now charges USD only. */
  const stopChargingInr = async (): Promise<void> => {
    const res = await w.operator('PATCH', '/billing-credentials/razorpay', { currencies: ['USD'] });
    expect(res.statusCode, res.body).toBe(200);
  };

  describe('the setting', () => {
    it('reads `fallback` on an Application that never set it, and what was set afterwards', async () => {
      const before = await w.operator('GET', '');
      expect(before.statusCode, before.body).toBe(200);
      expect(before.json().data.billingConfig.onUnavailableCurrency).toBe('fallback');

      const set = await patch({ onUnavailableCurrency: 'refuse' });
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json().data.billingConfig.onUnavailableCurrency).toBe('refuse');
      expect((await w.operator('GET', '')).json().data.billingConfig.onUnavailableCurrency).toBe('refuse');
    });

    it('reads `fallback` on an Application stored before the setting existed, from every route that returns the config', async () => {
      await prisma.$executeRaw`UPDATE "applications" SET "billing_config" = "billing_config" - 'onUnavailableCurrency' WHERE "id" = ${w.applicationId}`;
      const one = await w.operator('GET', '');
      expect(one.json().data.billingConfig.onUnavailableCurrency).toBe('fallback');
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/applications',
        headers: { authorization: `Bearer ${w.operatorAccess}` },
      });
      expect(list.statusCode, list.body).toBe(200);
      const row = (list.json().data as { items: Array<{ id: string; billingConfig: { onUnavailableCurrency?: string } }> }).items.find(
        (item) => item.id === w.applicationId,
      );
      expect(row!.billingConfig.onUnavailableCurrency).toBe('fallback');
      // A patch of something else returns the whole config, this key included.
      const patched = await patch({ dunningEnabled: true });
      expect(patched.json().data.billingConfig.onUnavailableCurrency).toBe('fallback');
      expect(await logged('settings.unavailable_currency_changed')).toEqual([]);
    });

    it('logs a change with the value before and after and the operator who made it, and nothing for the same value again', async () => {
      await setDefault('refuse');
      await setDefault('refuse');
      const once = await logged('settings.unavailable_currency_changed');
      expect(once).toHaveLength(1);
      expect(once[0]).toMatchObject({ actor: { type: 'operator' }, data: { before: 'fallback', after: 'refuse' } });
      expect(once[0]!.actor.id).toEqual(expect.any(String));

      await setDefault('fallback');
      const twice = await logged('settings.unavailable_currency_changed');
      expect(twice.map((entry) => entry.data)).toEqual(
        expect.arrayContaining([
          { before: 'fallback', after: 'refuse' },
          { before: 'refuse', after: 'fallback' },
        ]),
      );
      expect(twice).toHaveLength(2);
    });
  });

  describe('with the default set to refuse, and a named currency nobody can charge', () => {
    beforeEach(async () => {
      await stopChargingInr();
      await setDefault('refuse');
    });

    it('refuses a checkout that names no rule of its own, and the fix it gives works', async () => {
      const refused = await w.checkout({ currency: 'INR' });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error.code).toBe('BILLING_NO_PROVIDER_FOR_CURRENCY');
      const fix = refused.json().error.fix as string;
      expect(fix).toContain('send `onUnavailableCurrency: "fallback"` with this request');
      expect(fix).toContain('PATCH /api/v1/tenant/applications/:id/billing-config with {"onUnavailableCurrency": "fallback"}');

      // The first remedy: the request says so itself, and wins over the Application.
      const { row } = await w.sessionOf(await w.checkout({ currency: 'INR', onUnavailableCurrency: 'fallback' }));
      expect(row.currency).toBe('USD');

      // The second: the Application default, set exactly as the fix writes it.
      await setDefault('fallback');
      const other = await w.newBuyer();
      const after = await w.checkout({ currency: 'INR' }, { buyer: other });
      expect(after.statusCode, after.body).toBe(200);
      expect(after.json().data.priceFallback).toMatchObject({ requested: { currency: 'INR' }, charged: { currency: 'USD' } });
    });

    it('refuses the coupon quote for that checkout, and quotes the default price when the request asks to fall back', async () => {
      const created = await w.operator('POST', '/coupons', { code: 'TENOFF', discountType: 'PERCENT', basisPoints: 1000 });
      expect(created.statusCode, created.body).toBe(201);

      const refused = await w.asBuyer('POST', '/coupons/validate', { code: 'TENOFF', planSlug: 'pro', currency: 'INR' });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error.code).toBe('BILLING_NO_PROVIDER_FOR_CURRENCY');

      const quoted = await w.asBuyer('POST', '/coupons/validate', {
        code: 'TENOFF',
        planSlug: 'pro',
        currency: 'INR',
        onUnavailableCurrency: 'fallback',
      });
      expect(quoted.statusCode, quoted.body).toBe(200);
      expect(quoted.json().data).toMatchObject({ currency: 'USD', discountAmount: 200 });
    });

    it('previews the refusal, says which rule it applied, and applies the request rule when one is sent', async () => {
      const preview = async (extra: Record<string, unknown> = {}) => {
        const res = await w.operator('POST', '/billing/checkout/preview', {
          country: 'US',
          plan: 'pro',
          countrySource: 'declared',
          currency: 'INR',
          ...extra,
        });
        expect(res.statusCode, res.body).toBe(200);
        return res.json().data as {
          onUnavailableCurrency: string;
          items: Array<{ refusal: { code: string } | null; price: { currency: string } | null; priceFallback: unknown }>;
        };
      };
      const byDefault = await preview();
      expect(byDefault.onUnavailableCurrency).toBe('refuse');
      expect(byDefault.items[0]!.refusal?.code).toBe('BILLING_NO_PROVIDER_FOR_CURRENCY');

      const asked = await preview({ onUnavailableCurrency: 'fallback' });
      expect(asked.onUnavailableCurrency).toBe('fallback');
      expect(asked.items[0]!.refusal).toBeNull();
      expect(asked.items[0]!.price?.currency).toBe('USD');
      expect(asked.items[0]!.priceFallback).not.toBeNull();
    });

    it('still falls back for a buyer whose country selected the price: the default is about a currency the server names', async () => {
      const { row } = await w.sessionOf(await w.checkout({ country: 'IN' }));
      expect(row.currency).toBe('USD');

      const catalogue = await w.asBuyer('GET', '/plans?country=IN');
      expect(catalogue.statusCode, catalogue.body).toBe(200);
      const pro = (catalogue.json().data as { items: Array<{ slug: string; price: { currency: string; reason: string } }> }).items.find(
        (plan) => plan.slug === 'pro',
      );
      expect(pro!.price).toMatchObject({ currency: 'USD', reason: 'fallback' });
    });
  });

  describe('with the default left at fallback', () => {
    beforeEach(stopChargingInr);

    it('charges the default price for a named currency nobody can charge, and refuses when the request asks to', async () => {
      const refused = await w.checkout({ currency: 'INR', onUnavailableCurrency: 'refuse' });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error.code).toBe('BILLING_NO_PROVIDER_FOR_CURRENCY');

      const { row } = await w.sessionOf(await w.checkout({ currency: 'INR' }));
      expect(row.currency).toBe('USD');

      const preview = await w.operator('POST', '/billing/checkout/preview', { country: 'US', plan: 'pro', countrySource: 'declared', currency: 'INR' });
      expect(preview.json().data.onUnavailableCurrency).toBe('fallback');
    });
  });
});
